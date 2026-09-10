import assert from "assert";
import { type ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./support/server.js";
import { MuseumState } from "../src/rooms/schema/MuseumState.js";

describe("MuseumRoom", () => {
  let colyseus: ColyseusTestServer;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("puts every visitor in the same hall", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "A" });
    const b = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "B" });

    assert.strictEqual(a.roomId, b.roomId);
  });

  it("lists a visitor only once they have reported where they stand", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "Ani" });
    const room = colyseus.getRoomById<MuseumState>(a.roomId);
    await room.waitForNextPatch();

    assert.strictEqual(room.state.visitors.size, 0, "no row before the first move");

    a.send("move", { x: 1.5, y: 2, z: -3.25, yaw: 90 });
    await room.waitForMessage("move");

    const visitor = room.state.visitors.get(a.sessionId);
    assert.ok(visitor);
    assert.strictEqual(visitor.displayName, "Ani");
    assert.deepStrictEqual([visitor.x, visitor.y, visitor.z, visitor.yaw], [1.5, 2, -3.25, 90]);
  });

  it("syncs one visitor's position to another", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "A" });
    const b = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "B" });
    const room = colyseus.getRoomById<MuseumState>(a.roomId);

    a.send("move", { x: 4, y: 0, z: 5, yaw: 180 });
    await room.waitForMessage("move");
    await room.waitForNextPatch();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const seen = b.state.visitors.get(a.sessionId);
    assert.ok(seen, "B sees A");
    assert.strictEqual(seen.displayName, "A");
    assert.strictEqual(seen.x, 4);
    assert.strictEqual(seen.z, 5);
  });

  it("normalises yaw into 0..360", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "A" });
    const room = colyseus.getRoomById<MuseumState>(a.roomId);

    a.send("move", { x: 0, y: 0, z: 0, yaw: -90 });
    await room.waitForMessage("move");

    assert.strictEqual(room.state.visitors.get(a.sessionId)?.yaw, 270);
  });

  it("rejects a malformed move with invalid_move and lists nobody", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "A" });
    const room = colyseus.getRoomById<MuseumState>(a.roomId);

    const error = nextMessage(a, "error");
    a.send("move", { x: "far", y: 0, z: Infinity, yaw: 0 });

    assert.strictEqual((await error)?.code, "invalid_move");
    assert.strictEqual(room.state.visitors.size, 0);
  });

  it("drops a visitor from the hall when they leave", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "A" });
    const b = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "B" });
    const room = colyseus.getRoomById<MuseumState>(a.roomId);

    a.send("move", { x: 1, y: 0, z: 1, yaw: 0 });
    await room.waitForMessage("move");
    assert.strictEqual(room.state.visitors.size, 1);

    await a.leave(true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(room.state.visitors.has(a.sessionId), false);
    assert.strictEqual(room.clients.length, 1, "B is still walking");
    void b;
  });
});

function nextMessage(room: any, type: string): Promise<any> {
  return new Promise((resolve) => room.onMessage(type, resolve));
}
