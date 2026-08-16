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

  it("deals a board when the match starts", async () => {
    const { host, room } = await startedMatch();

    assert.strictEqual(room.state.phase, "in_progress");
    assert.strictEqual(room.state.holes.length, 20);
    assert.strictEqual(room.state.centerPoolCount, 45);
    assert.strictEqual(room.state.hand.length, 15);
    assert.strictEqual(room.state.nextHoleIndex, 0);
    assert.strictEqual(room.state.activePlayer, host.sessionId, "seat 0 opens");
    assert.strictEqual(room.state.storehouses.size, 2);

    const seed = room.state.hand[0];
    assert.ok(seed.id.length > 0 && seed.typeId.length > 0);
    assert.ok(["monocot", "dicot"].includes(seed.category));
  });

  it("applies a legal drop and refuses one from the waiting player", async () => {
    const { host, guest, room } = await startedMatch();

    const seedId = room.state.hand[0].id;
    const holeIndex = room.state.nextHoleIndex;

    const rejected = nextError(guest);
    guest.send("drop_seed", { seedId, holeIndex });
    assert.strictEqual((await rejected)?.code, "not_your_turn");
    assert.strictEqual(room.state.hand.length, 15, "nothing moved");

    host.send("drop_seed", { seedId, holeIndex });
    await room.waitForNextPatch();

    assert.strictEqual(room.state.hand.length, 14);
    assert.strictEqual(room.state.nextHoleIndex, holeIndex + 1);

    const scored =
      (room.state.storehouses.get(host.sessionId)?.total ?? 0) +
      (room.state.storehouses.get(guest.sessionId)?.total ?? 0);
    assert.strictEqual(scored, 1, "every drop scores for exactly one side");
  });

  it("refuses a hole out of sequence and a seed not in hand", async () => {
    const { host, room } = await startedMatch();

    const wrongHole = nextError(host);
    host.send("drop_seed", { seedId: room.state.hand[0].id, holeIndex: 7 });
    assert.strictEqual((await wrongHole)?.code, "invalid_hole");

    const noSeed = nextError(host);
    host.send("drop_seed", { seedId: "not-a-seed", holeIndex: room.state.nextHoleIndex });
    assert.strictEqual((await noSeed)?.code, "seed_not_in_hand");

    assert.strictEqual(room.state.hand.length, 15);
  });

  it("hands the turn to the other seat when a hand empties", async () => {
    const { host, guest, room } = await startedMatch();

    for (let i = 0; i < 15; i++) {
      host.send("drop_seed", {
        seedId: room.state.hand[0].id,
        holeIndex: room.state.nextHoleIndex,
      });
      await room.waitForNextPatch();
    }

    assert.strictEqual(room.state.activePlayer, guest.sessionId);
    assert.strictEqual(room.state.nextHoleIndex, 10, "seat 1 starts on its own side");
    assert.strictEqual(room.state.hand.length, 15, "fresh draw");
    assert.strictEqual(room.state.centerPoolCount, 30);
  });

  it("describes every applied drop, the turn-ending one included", async () => {
    const { host, guest, room } = await startedMatch();

    const applied: any[] = [];
    host.onMessage("drop_applied", (payload: any) => applied.push(payload));

    // The whole first hand. The 15th drop empties it, and the server refills in the same
    // call — which is exactly the drop a client cannot see by diffing state patches, because
    // the patch after it carries a *bigger* hand than the patch before.
    const played: string[] = [];
    for (let i = 0; i < 15; i++) {
      const seed = room.state.hand[0];
      played.push(seed.id);
      const typeId = seed.typeId;
      const holeIndex = room.state.nextHoleIndex;

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

    assert.strictEqual(applied.length, 15, "one report per drop, none swallowed");
    assert.deepStrictEqual(
      applied.map((d) => d.seedId),
      played,
    );
    assert.strictEqual(applied[14].turnEnded, true, "the 15th ends the turn");
    assert.strictEqual(
      applied.filter((d) => d.turnEnded).length,
      1,
      "and only the 15th does",
    );
    assert.strictEqual(room.state.activePlayer, guest.sessionId);
  });

  it("plays to the end and broadcasts game_over with the server's scores", async () => {
    const { host, guest, room } = await startedMatch();

    const finished = new Promise<any>((resolve) => host.onMessage("game_over", resolve));

    // 60 seeds, 15 per hand → 4 hands, whoever is to act.
    for (let drop = 0; drop < 60; drop++) {
      const actor = room.state.activePlayer === host.sessionId ? host : guest;
      actor.send("drop_seed", {
        seedId: room.state.hand[0].id,
        holeIndex: room.state.nextHoleIndex,
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
