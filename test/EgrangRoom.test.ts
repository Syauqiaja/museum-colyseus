import assert from "assert";
import { type ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./support/server.js";
import { EgrangState } from "../src/rooms/schema/EgrangState.js";

describe("EgrangRoom", () => {
  let colyseus: ColyseusTestServer;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  async function startedRace() {
    const host = await colyseus.sdk.create<EgrangState>("egrang", { private: true, displayName: "A" });
    const two = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "B" });
    const three = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "C" });
    const room = colyseus.getRoomById<EgrangState>(host.roomId);
    await room.waitForNextPatch();
    return { host, two, three, room };
  }

  it("seats three racers and arms a countdown when the room fills", async () => {
    const { host, two, three, room } = await startedRace();

    assert.strictEqual(room.state.phase, "in_progress");
    assert.strictEqual(room.state.racers.size, 3);
    assert.strictEqual(room.state.finishUnits, 50);

    const aheadMs = room.state.startsAtMs - Date.now();
    assert.ok(
      aheadMs >= 14000 && aheadMs <= 15500,
      `expected startsAtMs ~15s ahead of now, got ${aheadMs}ms`,
    );

    for (const client of [host, two, three]) {
      const racer = room.state.racers.get(client.sessionId);
      assert.ok(racer, "every seated client gets a racer");
      assert.strictEqual(racer.stepUnits, 0);
      assert.strictEqual(racer.place, 0);
    }
  });

  it("answers countdown_sync with 0 while the room is still waiting", async () => {
    const host = await colyseus.sdk.create<EgrangState>("egrang", { private: true, displayName: "A" });
    const room = colyseus.getRoomById<EgrangState>(host.roomId);
    await room.waitForNextPatch();

    const countdown = nextMessage(host, "countdown");
    host.send("countdown_sync", {});

    assert.strictEqual((await countdown)?.remainingMs, 0);
  });

  it("answers countdown_sync with the time left once the race is armed", async () => {
    // The Unity client reconnects into the room while loading the scene, so it usually
    // misses the broadcast that went out at game start; this reply is what it actually
    // renders the countdown from.
    const { host, room } = await startedRace();

    const countdown = nextMessage(host, "countdown");
    host.send("countdown_sync", {});
    const payload = await countdown;

    assert.strictEqual(payload?.startsAtMs, room.state.startsAtMs);
    assert.ok(
      payload.remainingMs > 0 && payload.remainingMs <= 15000,
      `expected a remaining countdown inside the window, got ${payload?.remainingMs}ms`,
    );
  });

  it("reports no countdown left once the race is open", async () => {
    const { host, room } = await startedRace();
    openRace(room);

    const countdown = nextMessage(host, "countdown");
    host.send("countdown_sync", {});

    assert.strictEqual((await countdown)?.remainingMs, 0);
  });

  it("records a stilt choice before the race starts", async () => {
    const host = await colyseus.sdk.create<EgrangState>("egrang", { private: true, displayName: "A" });
    const room = colyseus.getRoomById<EgrangState>(host.roomId);
    await room.waitForNextPatch();

    host.send("choose_stick", { shape: 2 });
    await room.waitForNextPatch();

    const racer = room.state.racers.get(host.sessionId);
    assert.strictEqual(racer?.stick, 2);
    assert.strictEqual(racer?.ready, true);
  });

  it("does not leave a ghost racer for someone who chose a stilt then left before the race started", async () => {
    const host = await colyseus.sdk.create<EgrangState>("egrang", { private: true, displayName: "A" });
    const two = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "B" });
    const room = colyseus.getRoomById<EgrangState>(host.roomId);
    await room.waitForNextPatch();

    two.send("choose_stick", { shape: 1 });
    await room.waitForNextPatch();

    const departedSessionId = two.sessionId;
    // Consented leave: skips the reconnection window so onLeave fires right away.
    await two.leave(true);
    await room.waitForNextPatch();

    const three = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "C" });
    await room.waitForNextPatch();
    void three;

    // Only two seats are filled (host + three) after the departure, so the room
    // does not auto-start at maxClients; the host starts it explicitly.
    host.send("start_game");
    await room.waitForNextPatch();

    assert.strictEqual(room.state.phase, "in_progress");
    assert.strictEqual(room.state.racers.has(departedSessionId), false);
    assert.strictEqual(room.state.racers.size, room.state.players.size);
  });

  it("keeps a stilt chosen while waiting once the race starts", async () => {
    const host = await colyseus.sdk.create<EgrangState>("egrang", { private: true, displayName: "A" });
    const room = colyseus.getRoomById<EgrangState>(host.roomId);
    await room.waitForNextPatch();

    host.send("choose_stick", { shape: 2 });
    await room.waitForNextPatch();

    const two = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "B" });
    const three = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "C" });
    void two;
    void three;
    await room.waitForNextPatch();

    assert.strictEqual(room.state.phase, "in_progress");
    assert.strictEqual(room.state.racers.get(host.sessionId)?.stick, 2);
  });

  it("accepts a stilt chosen after the race has started, before that racer's first step", async () => {
    const { host, room } = await startedRace();
    openRace(room);

    // The Unity client loads the Egrang scene — where the stilt picker lives —
    // only after the match has already started, so this is the common case,
    // not an edge case.
    host.send("choose_stick", { shape: 1 });
    await room.waitForNextPatch();

    const racer = room.state.racers.get(host.sessionId);
    assert.strictEqual(room.state.phase, "in_progress");
    assert.strictEqual(racer?.stick, 1);
    assert.strictEqual(racer?.ready, true);
  });

  it("rejects a stilt chosen after that racer has taken a step, and leaves the stored stilt unchanged", async () => {
    const { host, room } = await startedRace();
    openRace(room);

    host.send("choose_stick", { shape: 1 });
    await room.waitForNextPatch();

    host.send("step", { result: 2 });
    await room.waitForNextPatch();

    const error = nextMessage(host, "error");
    host.send("choose_stick", { shape: 2 });

    assert.strictEqual((await error)?.code, "invalid_move");
    assert.strictEqual(room.state.racers.get(host.sessionId)?.stick, 1);
  });

  /**
   * Opens the race for a test: arms both the synced `startsAtMs` (what clients
   * read) and the engine's own armed instant (what `EgrangRace.step` actually
   * checks). In production `onGameStart` sets both from the same value, so they
   * never diverge; a test that wants the countdown out of the way has to arm
   * both copies itself.
   */
  function openRace(room: any) {
    const now = Date.now() - 1;
    room.state.startsAtMs = now;
    room.race.arm(now);
  }

  /** Resolves with the first message of `type`, or null after 250 ms. */
  function nextMessage<T = any>(client: any, type: string): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 250);
      client.onMessage(type, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  it("banks an accepted step and tells everyone about it", async () => {
    const { host, two, room } = await startedRace();
    openRace(room);

    const seenByOther = nextMessage(two, "step_taken");
    const seenBySender = nextMessage(host, "step_taken");
    host.send("step", { result: 2 });

    const payload = await seenByOther;
    assert.deepStrictEqual(payload, { sessionId: host.sessionId, result: 2, stepUnits: 2 });
    // The broadcast must reach everyone, including the sender — not `{ except: client }`.
    assert.deepStrictEqual(await seenBySender, payload);
    assert.strictEqual(room.state.racers.get(host.sessionId)?.stepUnits, 2);
  });

  it("rejects a second step inside the rate limit", async () => {
    const { host, room } = await startedRace();
    openRace(room);

    host.send("step", { result: 2 });
    await room.waitForNextPatch();

    const error = nextMessage(host, "error");
    host.send("step", { result: 2 });

    assert.strictEqual((await error)?.code, "invalid_move");
    assert.strictEqual(room.state.racers.get(host.sessionId)?.stepUnits, 2);
  });

  it("rejects a step taken before the countdown ends", async () => {
    const { host, room } = await startedRace();

    const error = nextMessage(host, "error");
    host.send("step", { result: 2 });

    assert.strictEqual((await error)?.code, "invalid_move");
    assert.strictEqual(room.state.racers.get(host.sessionId)?.stepUnits, 0);
  });

  it("ends the race the moment the first racer crosses the line", async () => {
    const { host, room } = await startedRace();
    openRace(room);
    (room as any).race.finishUnits = 2;
    room.state.finishUnits = 2;

    const over = nextMessage(host, "game_over");
    host.send("step", { result: 2 });

    const payload = await over;
    assert.strictEqual(payload?.winner, host.sessionId);
    assert.strictEqual(payload?.places[host.sessionId], 1);
    assert.strictEqual(room.state.racers.get(host.sessionId)?.place, 1);
    assert.strictEqual(room.state.phase, "finished");
  });

  it("leaves the racers who were still running unplaced when the winner lands", async () => {
    const { host, two, three, room } = await startedRace();
    openRace(room);
    (room as any).race.finishUnits = 2;
    room.state.finishUnits = 2;

    const over = nextMessage(host, "game_over");

    // finishUnits = 2, so one full step finishes. `two` banks a half step and is
    // still on the course when the host crosses; `three` never steps at all.
    two.send("step", { result: 1 });
    await room.waitForNextPatch();
    host.send("step", { result: 2 });

    const payload = await over;
    assert.strictEqual(payload?.winner, host.sessionId);
    assert.strictEqual(payload?.places[host.sessionId], 1);
    assert.strictEqual(payload?.places[two.sessionId], 0);
    assert.strictEqual(payload?.places[three.sessionId], 0);
    assert.strictEqual(room.state.racers.get(host.sessionId)?.place, 1);
    assert.strictEqual(room.state.racers.get(two.sessionId)?.stepUnits, 1);
    assert.strictEqual(room.state.phase, "finished");
  });

  it("keeps the race running for two survivors when a third racer leaves mid-race", async () => {
    const { host, two, three, room } = await startedRace();
    openRace(room);
    (room as any).race.finishUnits = 2;
    room.state.finishUnits = 2;

    const departedSessionId = three.sessionId;
    await three.leave(true);
    await room.waitForNextPatch();

    assert.strictEqual(room.state.phase, "in_progress");
    assert.strictEqual(room.state.players.size, 2);
    // The departed racer's row is left frozen, not deleted.
    assert.strictEqual(room.state.racers.has(departedSessionId), true);

    const over = nextMessage(host, "game_over");

    host.send("step", { result: 2 });

    const payload = await over;
    assert.strictEqual(payload?.winner, host.sessionId);
    assert.strictEqual(payload?.places[host.sessionId], 1);
    // Still running when the winner landed, and the racer who left, both unplaced.
    assert.strictEqual(payload?.places[two.sessionId], 0);
    assert.strictEqual(payload?.places[departedSessionId], 0);
    assert.strictEqual(room.state.racers.get(host.sessionId)?.place, 1);
    assert.strictEqual(room.state.phase, "finished");
  });

  it("still ends the race by forfeit when it drops to one remaining player", async () => {
    const { host, two, three, room } = await startedRace();
    openRace(room);

    await two.leave(true);
    await room.waitForNextPatch();

    const departedSessionId = three.sessionId;
    await three.leave(true);
    await room.waitForNextPatch();

    assert.strictEqual(room.state.phase, "finished");
    assert.strictEqual(room.state.players.size, 1);
    assert.strictEqual(room.state.players.has(host.sessionId), true);
    void departedSessionId;
  });
});
