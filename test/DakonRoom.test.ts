import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { testServer } from "./support/server.js";
import type { DakonState } from "../src/rooms/schema/DakonState.js";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

describe("DakonRoom — room system", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("create private: 6-char code, hidden from public matchmaking", async () => {
    const priv = await colyseus.sdk.create<DakonState>("dakon", { private: true, displayName: "A" });

    assert.strictEqual(priv.roomId.length, 6);
    assert.ok([...priv.roomId].every((c) => CODE_ALPHABET.includes(c)), "code uses safe alphabet");

    // A public join-or-create must NOT land in the private room → makes a new one.
    const pub = await colyseus.sdk.joinOrCreate<DakonState>("dakon", { displayName: "B" });
    assert.notStrictEqual(pub.roomId, priv.roomId);
  });

  it("public join-or-create: two players share one room, auto-starts + locks when full", async () => {
    const c1 = await colyseus.sdk.joinOrCreate<DakonState>("dakon", { displayName: "A" });
    const c2 = await colyseus.sdk.joinOrCreate<DakonState>("dakon", { displayName: "B" });

    assert.strictEqual(c1.roomId, c2.roomId, "second player joined the same room");

    const room = colyseus.getRoomById(c1.roomId);
    await room.waitForNextPatch();

    assert.strictEqual(room.state.phase, "in_progress");
    assert.strictEqual(room.state.players.size, 2);
    assert.strictEqual(room.locked, true);
    assert.strictEqual(room.state.hostSessionId, c1.sessionId, "first joiner is host");
  });

  it("join by code: second client joins host's room via roomId", async () => {
    const host = await colyseus.sdk.create<DakonState>("dakon", { private: true, displayName: "A" });
    const guest = await colyseus.sdk.joinById<DakonState>(host.roomId, { displayName: "B" });

    assert.strictEqual(guest.roomId, host.roomId);
  });

  it("rejects a third player once the room is full/started", async () => {
    const host = await colyseus.sdk.create<DakonState>("dakon", { private: true, displayName: "A" });
    await colyseus.sdk.joinById<DakonState>(host.roomId, { displayName: "B" });

    await assert.rejects(
      () => colyseus.sdk.joinById<DakonState>(host.roomId, { displayName: "C" }),
      "third join must be rejected",
    );
  });

  it("reconnection: dropped player keeps its seat, match not ended", async () => {
    const c1 = await colyseus.sdk.joinOrCreate<DakonState>("dakon", { displayName: "A" });
    const c2 = await colyseus.sdk.joinOrCreate<DakonState>("dakon", { displayName: "B" });

    const room = colyseus.getRoomById<DakonState>(c1.roomId);
    const token = c2.reconnectionToken;

    // Unconsented leave → server onDrop holds the seat open.
    c2.reconnectionEnabled = false; // don't let the SDK auto-reconnect for us
    await c2.leave(false);

    await room.waitForNextPatch();
    assert.strictEqual(room.state.players.size, 2, "seat held during reconnection window");
    assert.strictEqual(room.state.players.get(c2.sessionId)?.connected, false);
    assert.strictEqual(room.state.phase, "in_progress", "match not ended");

    // Reconnect within the window.
    const c2b = await colyseus.sdk.reconnect<DakonState>(token);
    await room.waitForNextPatch();

    assert.strictEqual(room.state.players.get(c2b.sessionId)?.connected, true);
    assert.strictEqual(room.state.phase, "in_progress");
  });
});
