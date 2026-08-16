import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { testServer } from "./support/server.js";
import type { DakonState } from "../src/rooms/schema/DakonState.js";
import type { EgrangState } from "../src/rooms/schema/EgrangState.js";

/**
 * The host-driven start contract the Unity lobby is built against: the host holds a
 * Start button, it is only live once `minPlayers` are seated, and a rejected start
 * leaves everyone where they are (an `error` message, not a kick).
 */
describe("start_game", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  /** Wait for one `error` message, or resolve undefined after a beat. */
  function nextError(room: any): Promise<{ code: string; message: string } | undefined> {
    return new Promise((resolve) => {
      room.onMessage("error", (payload: any) => resolve(payload));
      setTimeout(() => resolve(undefined), 250);
    });
  }

  it("egrang seats three and lets the host start with two", async () => {
    const host = await colyseus.sdk.create<EgrangState>("egrang", {
      private: true,
      displayName: "A",
    });
    const guest = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "B" });

    const room = colyseus.getRoomById<EgrangState>(host.roomId);
    await room.waitForNextPatch();

    assert.strictEqual(room.maxClients, 3);
    assert.strictEqual(room.state.phase, "waiting", "two of three does not auto-start");
    assert.strictEqual(room.state.players.get(host.sessionId)?.seat, 0);
    assert.strictEqual(room.state.players.get(guest.sessionId)?.seat, 1);

    host.send("start_game");
    await room.waitForNextPatch();

    assert.strictEqual(room.state.phase, "in_progress");
    assert.strictEqual(room.locked, true);
  });

  it("rejects a start from a non-host and leaves the room waiting", async () => {
    const host = await colyseus.sdk.create<EgrangState>("egrang", {
      private: true,
      displayName: "A",
    });
    const guest = await colyseus.sdk.joinById<EgrangState>(host.roomId, { displayName: "B" });
    const room = colyseus.getRoomById<EgrangState>(host.roomId);

    const failure = nextError(guest);
    guest.send("start_game");

    assert.strictEqual((await failure)?.code, "not_host");
    assert.strictEqual(room.state.phase, "waiting");
    assert.strictEqual(guest.connection.isOpen, true, "a rejected start does not kick anyone");
  });

  it("rejects a start below minPlayers", async () => {
    const host = await colyseus.sdk.create<EgrangState>("egrang", {
      private: true,
      displayName: "A",
    });
    const room = colyseus.getRoomById<EgrangState>(host.roomId);

    const failure = nextError(host);
    host.send("start_game");

    assert.strictEqual((await failure)?.code, "not_enough_players");
    assert.strictEqual(room.state.phase, "waiting");
  });

  it("rejects a second start once the match is running", async () => {
    const host = await colyseus.sdk.create<DakonState>("dakon", {
      private: true,
      displayName: "A",
    });
    await colyseus.sdk.joinById<DakonState>(host.roomId, { displayName: "B" });

    const room = colyseus.getRoomById<DakonState>(host.roomId);
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "in_progress", "dakon fills at 2 and starts itself");

    const failure = nextError(host);
    host.send("start_game");

    assert.strictEqual((await failure)?.code, "already_started");
  });
});
