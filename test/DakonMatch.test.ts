import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { testServer } from "./support/server.js";
import type { DakonState } from "../src/rooms/schema/DakonState.js";

/**
 * The Dakon room seen from a client: what the state looks like once the match
 * starts, what a legal and an illegal `drop_seed` do, and the `game_over` payload.
 * The rules themselves are pinned in DakonBoard.test.ts — this file is the wire.
 */
describe("DakonRoom — match", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  /** Two seated clients in a started match, plus the server-side room. */
  async function startedMatch() {
    const host = await colyseus.sdk.create<DakonState>("dakon", {
      private: true,
      displayName: "A",
      playerId: "11111111-1111-1111-1111-111111111111",
    });
    const guest = await colyseus.sdk.joinById<DakonState>(host.roomId, {
      displayName: "B",
      playerId: "22222222-2222-2222-2222-222222222222",
    });

    const room = colyseus.getRoomById<DakonState>(host.roomId);
    await room.waitForNextPatch();

    return { host, guest, room };
  }

  function nextError(room: any): Promise<{ code: string } | undefined> {
    return new Promise((resolve) => {
      room.onMessage("error", (payload: any) => resolve(payload));
      setTimeout(() => resolve(undefined), 250);
    });
  }

  /** Which seat a session holds: 0 if it opened, 1 otherwise. */
  function seatOf(state: DakonState, sessionId: string): number {
    return state.players.get(sessionId)!.seat;
  }

  /** First hole on the active seat's side that has not taken a seed this turn. */
  function freeHole(state: DakonState): number {
    const seat = seatOf(state, state.activePlayer);
    for (let i = seat * 10; i < seat * 10 + 10; i++) {
      if ((state.sownMask & (1 << i)) === 0) return i;
    }
    assert.fail("no free hole on the active side");
  }

  it("deals a board when the match starts", async () => {
    const { host, room } = await startedMatch();

    assert.strictEqual(room.state.phase, "in_progress");
    assert.strictEqual(room.state.holes.length, 20);
    assert.strictEqual(room.state.centerPoolCount, 50);
    assert.strictEqual(room.state.hand.length, 10);
    assert.strictEqual(room.state.sownMask, 0);
    assert.strictEqual(room.state.activePlayer, host.sessionId, "seat 0 opens");
    assert.strictEqual(room.state.storehouses.size, 2);

    const seed = room.state.hand[0];
    assert.ok(seed.id.length > 0 && seed.typeId.length > 0);
    assert.ok(["monocot", "dicot"].includes(seed.category));
  });

  it("applies a legal drop and refuses one from the waiting player", async () => {
    const { host, guest, room } = await startedMatch();

    const seedId = room.state.hand[0].id;
    const holeIndex = 3; // any own hole — the player picks, not the ring

    const rejected = nextError(guest);
    guest.send("drop_seed", { seedId, holeIndex });
    assert.strictEqual((await rejected)?.code, "not_your_turn");
    assert.strictEqual(room.state.hand.length, 10, "nothing moved");

    host.send("drop_seed", { seedId, holeIndex });
    await room.waitForNextPatch();

    assert.strictEqual(room.state.hand.length, 9);
    assert.strictEqual(room.state.sownMask, 1 << holeIndex, "the hole is marked taken");

    const scored =
      (room.state.storehouses.get(host.sessionId)?.total ?? 0) +
      (room.state.storehouses.get(guest.sessionId)?.total ?? 0);
    assert.strictEqual(scored, 1, "every drop scores for exactly one side");
  });

  it("refuses the opponent's hole, a hole already sown this turn, and a seed not in hand", async () => {
    const { host, room } = await startedMatch();

    const wrongSide = nextError(host);
    host.send("drop_seed", { seedId: room.state.hand[0].id, holeIndex: 14 });
    assert.strictEqual((await wrongSide)?.code, "invalid_hole");

    host.send("drop_seed", { seedId: room.state.hand[0].id, holeIndex: 7 });
    await room.waitForNextPatch();

    const twice = nextError(host);
    host.send("drop_seed", { seedId: room.state.hand[0].id, holeIndex: 7 });
    assert.strictEqual((await twice)?.code, "hole_already_sown");

    const noSeed = nextError(host);
    host.send("drop_seed", { seedId: "not-a-seed", holeIndex: freeHole(room.state) });
    assert.strictEqual((await noSeed)?.code, "seed_not_in_hand");

    assert.strictEqual(room.state.hand.length, 9, "only the one legal drop moved");
  });

  it("hands the turn to the other seat when a hand empties", async () => {
    const { host, guest, room } = await startedMatch();

    for (let i = 0; i < 10; i++) {
      host.send("drop_seed", {
        seedId: room.state.hand[0].id,
        holeIndex: freeHole(room.state),
      });
      await room.waitForNextPatch();
    }

    assert.strictEqual(room.state.activePlayer, guest.sessionId);
    assert.strictEqual(room.state.sownMask, 0, "a fresh turn has no sown holes");
    assert.strictEqual(room.state.hand.length, 10, "fresh draw");
    assert.strictEqual(room.state.centerPoolCount, 40);
  });

  it("describes every applied drop, the turn-ending one included", async () => {
    const { host, guest, room } = await startedMatch();

    const applied: any[] = [];
    host.onMessage("drop_applied", (payload: any) => applied.push(payload));

    // The whole first hand. The 10th drop empties it, and the server refills in the same
    // call — which is exactly the drop a client cannot see by diffing state patches, because
    // the patch after it carries a hand the same size as the patch before.
    const played: string[] = [];
    for (let i = 0; i < 10; i++) {
      const seed = room.state.hand[0];
      played.push(seed.id);
      const typeId = seed.typeId;
      const holeIndex = freeHole(room.state);

      host.send("drop_seed", { seedId: seed.id, holeIndex });
      await room.waitForNextPatch();

      const last = applied[applied.length - 1];
      assert.ok(last, `drop ${i} was never reported`);
      assert.strictEqual(last.seedId, seed.id);
      assert.strictEqual(last.holeIndex, holeIndex);
      assert.strictEqual(last.typeId, typeId, "species survives the drop that removes the seed");
      assert.ok([0, 1].includes(last.scoringPlayer), "a seat, not a sessionId");
      assert.strictEqual(last.gameOver, false);
    }

    assert.strictEqual(applied.length, 10, "one report per drop, none swallowed");
    assert.deepStrictEqual(
      applied.map((d) => d.seedId),
      played,
    );
    assert.strictEqual(applied[9].turnEnded, true, "the 10th ends the turn");
    assert.strictEqual(
      applied.filter((d) => d.turnEnded).length,
      1,
      "and only the 10th does",
    );
    assert.strictEqual(room.state.activePlayer, guest.sessionId);
  });

  it("plays to the end and broadcasts game_over with the server's scores", async () => {
    const { host, guest, room } = await startedMatch();

    const finished = new Promise<any>((resolve) => host.onMessage("game_over", resolve));

    // 60 seeds, 10 per hand → 6 hands, whoever is to act.
    for (let drop = 0; drop < 60; drop++) {
      const actor = room.state.activePlayer === host.sessionId ? host : guest;
      actor.send("drop_seed", {
        seedId: room.state.hand[0].id,
        holeIndex: freeHole(room.state),
      });
      await room.waitForNextPatch();
    }

    const payload = await finished;

    assert.strictEqual(room.state.phase, "finished");
    assert.strictEqual(room.state.centerPoolCount, 0);

    const scores = payload.scores as Record<string, number>;
    assert.strictEqual(scores[host.sessionId] + scores[guest.sessionId], 60);

    const [a, b] = [scores[host.sessionId], scores[guest.sessionId]];
    const expected = a === b ? null : a > b ? host.sessionId : guest.sessionId;
    assert.strictEqual(payload.winner, expected);
  });
});
