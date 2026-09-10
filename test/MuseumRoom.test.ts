import assert from "assert";
import { type ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./support/server.js";
import { MuseumState } from "../src/rooms/schema/MuseumState.js";
import { MUSEUM_MAX_VISITORS } from "../src/rooms/MuseumRoom.js";

describe("MuseumRoom — hub presence", () => {
  let colyseus: ColyseusTestServer;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("puts two visitors who joinOrCreate into the same room, with their names", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "Aldi" });
    const b = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "Budi" });

    assert.strictEqual(a.roomId, b.roomId);

    const room = colyseus.getRoomById<MuseumState>(a.roomId);
    await room.waitForNextPatch();

    assert.strictEqual(room.state.visitors.size, 2);
    assert.strictEqual(room.state.visitors.get(a.sessionId)?.displayName, "Aldi");
    assert.strictEqual(room.state.visitors.get(b.sessionId)?.displayName, "Budi");
    assert.strictEqual(room.maxClients, MUSEUM_MAX_VISITORS);
  });

  it("relays a move into the sender's row", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "A" });
    const room = colyseus.getRoomById<MuseumState>(a.roomId);
    await room.waitForNextPatch();

    a.send("move", { x: 23.78, y: 4.62, z: 1.99, yaw: -15 });
    await room.waitForNextPatch();

    const me = room.state.visitors.get(a.sessionId)!;
    assert.ok(Math.abs(me.x - 23.78) < 1e-4);
    assert.ok(Math.abs(me.y - 4.62) < 1e-4);
    assert.ok(Math.abs(me.z - 1.99) < 1e-4);
    assert.ok(Math.abs(me.yaw - 345) < 1e-4, "yaw is normalised to 0..360");
  });

  it("drops a move that is not a finite position inside the building", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "A" });
    const room = colyseus.getRoomById<MuseumState>(a.roomId);
    await room.waitForNextPatch();

    a.send("move", { x: 1, y: 2, z: 3, yaw: 90 });
    await room.waitForNextPatch();

    a.send("move", { x: "far", y: 2, z: 3, yaw: 90 });
    a.send("move", { x: 9999, y: 2, z: 3, yaw: 90 });
    a.send("move", { x: 1, y: 2, z: 3, yaw: Infinity });
    await new Promise((r) => setTimeout(r, 150));

    const me = room.state.visitors.get(a.sessionId)!;
    assert.strictEqual(me.x, 1);
    assert.strictEqual(me.z, 3);
    assert.strictEqual(me.yaw, 90);
  });

  it("removes a visitor the moment they leave", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "A" });
    const b = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "B" });
    const room = colyseus.getRoomById<MuseumState>(a.roomId);
    await room.waitForNextPatch();

    await b.leave(true);
    await room.waitForNextPatch();

    assert.strictEqual(room.state.visitors.size, 1);
    assert.strictEqual(room.state.visitors.has(b.sessionId), false);
  });
});
