import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import appConfig from "../../src/app.config.js";
import { testServer } from "../support/server.js";
import type { DakonState } from "../../src/rooms/schema/DakonState.js";
import { closePool, getPool, isDbDisabled } from "../../src/db/pool.js";

/**
 * These tests hit a real MySQL (`npm run test:db`, after `npm run db:migrate`) —
 * the default `npm test` runs with DB_DISABLED=1 and never touches a database.
 *
 * They exist because the persistence layer's whole design is "never break the
 * game": every write is fire-and-forget and swallows its errors, which is exactly
 * the shape that silently writes nothing. So something has to actually read the
 * rows back.
 */
describe("persistence — players, matches, live seats", function () {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  const PLAYER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const PLAYER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

  before(async function () {
    if (isDbDisabled()) this.skip();

    try {
      await getPool()!.query("SELECT 1");
    } catch {
      console.warn("[test] no MySQL reachable — skipping persistence tests");
      this.skip();
    }

    colyseus = await testServer();
  });

  // The server is shared and torn down by the root hook; only the pool is ours.
  after(async () => await closePool());

  beforeEach(async () => {
    await colyseus.cleanup();
    const db = getPool()!;
    await db.query("DELETE FROM match_players");
    await db.query("DELETE FROM matches");
    await db.query("DELETE FROM live_sessions");
    await db.query("DELETE FROM players WHERE player_id IN (?, ?)", [PLAYER_A, PLAYER_B]);
  });

  async function rows<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const [result] = await getPool()!.query(sql, params);
    return result as T[];
  }

  /**
   * Persistence is fire-and-forget by design, so a row appears some time after the
   * event that caused it. Poll rather than sleep a fixed amount — a fixed wait is
   * either slow or flaky, and here it was flaky.
   */
  async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5000;
    let last = await read();

    while (!ok(last) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      last = await read();
    }

    return last;
  }

  it("writes a profile and a live seat on join, and clears the seat on leave", async () => {
    const host = await colyseus.sdk.create<DakonState>("dakon", {
      private: true,
      displayName: "Budi",
      playerId: PLAYER_A,
    });

    await colyseus.getRoomById(host.roomId).waitForNextPatch();

    const [profile] = await eventually(
      () => rows("SELECT * FROM players WHERE player_id = ?", [PLAYER_A]),
      (r) => r.length === 1,
    );
    assert.strictEqual(profile.display_name, "Budi");
    assert.strictEqual(profile.games_played, 0);

    const [seat] = await eventually(
      () => rows("SELECT * FROM live_sessions WHERE session_id = ?", [host.sessionId]),
      (r) => r.length === 1,
    );
    assert.strictEqual(seat.room_id, host.roomId);
    assert.strictEqual(seat.game, "dakon");
    assert.strictEqual(seat.seat, 0);
    assert.strictEqual(seat.player_id, PLAYER_A);
    assert.strictEqual(seat.connected, 1);

    await host.leave(true);

    const remaining = await eventually(
      () => rows("SELECT * FROM live_sessions WHERE session_id = ?", [host.sessionId]),
      (r) => r.length === 0,
    );
    assert.strictEqual(remaining.length, 0);
  });

  it("ignores a malformed playerId rather than rejecting the player", async () => {
    const host = await colyseus.sdk.create<DakonState>("dakon", {
      private: true,
      displayName: "NoId",
      playerId: "not-a-guid",
    });
    await colyseus.getRoomById(host.roomId).waitForNextPatch();

    const [seat] = await eventually(
      () => rows("SELECT * FROM live_sessions WHERE session_id = ?", [host.sessionId]),
      (r) => r.length === 1,
    );
    assert.strictEqual(seat.player_id, null, "seat recorded, profile not linked");
    assert.strictEqual(seat.display_name, "NoId");
  });

  it("opens a match row on start and closes it with scores at game over", async () => {
    const host = await colyseus.sdk.create<DakonState>("dakon", {
      private: true,
      displayName: "A",
      playerId: PLAYER_A,
    });
    const guest = await colyseus.sdk.joinById<DakonState>(host.roomId, {
      displayName: "B",
      playerId: PLAYER_B,
    });

    const room = colyseus.getRoomById<DakonState>(host.roomId);
    await room.waitForNextPatch();

    const [open] = await eventually(
      () => rows("SELECT * FROM matches WHERE room_id = ?", [host.roomId]),
      (r) => r.length === 1,
    );
    assert.strictEqual(open.outcome, "in_progress");
    assert.strictEqual(open.game, "dakon");
    assert.strictEqual(open.ended_at, null);
    assert.strictEqual(
      (await eventually(() => rows("SELECT * FROM match_players"), (r) => r.length === 2)).length,
      2,
    );

    const finished = new Promise<any>((resolve) => host.onMessage("game_over", resolve));
    for (let drop = 0; drop < 60; drop++) {
      const actor = room.state.activePlayer === host.sessionId ? host : guest;
      // First own hole not yet sown this turn: v7 lets the player pick, so the test does.
      const seat = room.state.players.get(actor.sessionId)!.seat;
      let holeIndex = seat * 10;
      while (room.state.sownMask & (1 << holeIndex)) holeIndex++;
      actor.send("drop_seed", {
        seedId: room.state.hand[0].id,
        holeIndex,
      });
      await room.waitForNextPatch();
    }
    const payload = await finished;

    const [closed] = await eventually(
      () => rows("SELECT * FROM matches WHERE room_id = ?", [host.roomId]),
      (r) => r[0]?.outcome === "completed",
    );
    assert.strictEqual(closed.outcome, "completed");
    assert.notStrictEqual(closed.ended_at, null);

    const seats = await rows("SELECT * FROM match_players ORDER BY seat");
    assert.deepStrictEqual(
      seats.map((s) => s.score),
      [payload.scores[host.sessionId], payload.scores[guest.sessionId]],
      "persisted scores are the server's own",
    );
    assert.strictEqual(
      seats.reduce((sum, s) => sum + s.score, 0),
      60,
    );

    // Winner and profile totals agree with the broadcast.
    const expectedWinner =
      payload.winner === host.sessionId ? PLAYER_A : payload.winner === null ? null : PLAYER_B;
    assert.strictEqual(closed.winner_player_id, expectedWinner);

    const profiles = await eventually(
      () => rows("SELECT * FROM players WHERE player_id IN (?, ?)", [PLAYER_A, PLAYER_B]),
      (r) => r.length === 2 && r.every((p) => p.games_played === 1),
    );
    assert.deepStrictEqual(
      profiles.map((p) => p.games_played),
      [1, 1],
    );
    assert.strictEqual(
      profiles.reduce((sum, p) => sum + p.wins, 0),
      expectedWinner === null ? 0 : 1,
    );
  });

  it("records a walkout as a forfeit for the player still sitting there", async () => {
    const host = await colyseus.sdk.create<DakonState>("dakon", {
      private: true,
      displayName: "A",
      playerId: PLAYER_A,
    });
    const guest = await colyseus.sdk.joinById<DakonState>(host.roomId, {
      displayName: "B",
      playerId: PLAYER_B,
    });

    const room = colyseus.getRoomById<DakonState>(host.roomId);
    await room.waitForNextPatch();
    const roomId = host.roomId;

    await guest.leave(true);

    const [match] = await eventually(
      () => rows("SELECT * FROM matches WHERE room_id = ?", [roomId]),
      (r) => r[0]?.outcome === "forfeited",
    );
    assert.strictEqual(match.outcome, "forfeited");
    assert.strictEqual(match.winner_player_id, PLAYER_A);
  });
});
