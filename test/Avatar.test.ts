import assert from "assert";
import { type ColyseusTestServer } from "@colyseus/testing";
import { testServer } from "./support/server.js";
import { EgrangState } from "../src/rooms/schema/EgrangState.js";
import { MuseumState } from "../src/rooms/schema/MuseumState.js";
import { sanitizeAvatar } from "../src/rooms/avatars.js";

describe("avatar join option", () => {
  let colyseus: ColyseusTestServer;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("keeps a known id, lower-cases it, and defaults anything else to jawa", () => {
    assert.strictEqual(sanitizeAvatar("bali"), "bali");
    assert.strictEqual(sanitizeAvatar(" Minang "), "minang");
    assert.strictEqual(sanitizeAvatar(undefined), "jawa");
    assert.strictEqual(sanitizeAvatar("dragon"), "jawa");
    assert.strictEqual(sanitizeAvatar(42), "jawa");
  });

  it("seats a game player wearing the avatar they chose", async () => {
    const host = await colyseus.sdk.create<EgrangState>("egrang", { private: true, displayName: "A", avatar: "bugis" });
    const two = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "B" });
    const three = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "C", avatar: "not-a-character" });
    const room = colyseus.getRoomById<EgrangState>(host.roomId);
    await room.waitForNextPatch();

    assert.strictEqual(room.state.players.get(host.sessionId)?.avatar, "bugis");
    assert.strictEqual(room.state.players.get(two.sessionId)?.avatar, "jawa", "no option -> default");
    assert.strictEqual(room.state.players.get(three.sessionId)?.avatar, "jawa", "unknown -> default");
  });

  it("gives a museum visitor the avatar they joined with", async () => {
    const a = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "A", avatar: "minang" });
    const b = await colyseus.sdk.joinOrCreate<MuseumState>("museum", { displayName: "B" });
    const room = colyseus.getRoomById<MuseumState>(a.roomId);

    a.send("move", { x: 0, y: 0, z: 0, yaw: 0 });
    await room.waitForMessage("move");
    b.send("move", { x: 1, y: 0, z: 1, yaw: 0 });
    await room.waitForMessage("move");

    assert.strictEqual(room.state.visitors.get(a.sessionId)?.avatar, "minang");
    assert.strictEqual(room.state.visitors.get(b.sessionId)?.avatar, "jawa");
  });
});
