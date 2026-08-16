import { boot, type ColyseusTestServer } from "@colyseus/testing";
import appConfig from "../../src/app.config.js";

/**
 * One booted test server for the whole mocha run.
 *
 * `boot()` starts a real HTTP/WebSocket server, so a second one in the same
 * process fights the first for the port and every matchmaking call fails with
 * `MatchMakeError`. Test files therefore share this instance and only call
 * `cleanup()` between tests; the shutdown is a root hook below.
 *
 * Wired in via `mocha --require test/support/server.ts` (see package.json).
 */
let booting: Promise<ColyseusTestServer<typeof appConfig>> | undefined;

export function testServer(): Promise<ColyseusTestServer<typeof appConfig>> {
  booting ??= boot(appConfig);
  return booting;
}

export const mochaHooks = {
  async afterAll() {
    if (!booting) return;
    const server = await booting;
    booting = undefined;
    await server.shutdown();
  },
};
