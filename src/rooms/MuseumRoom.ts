import { Client, Room } from "colyseus";
import { MuseumState, MuseumVisitor } from "./schema/MuseumState.js";
import { type AvatarId, sanitizeAvatar } from "./avatars.js";

/**
 * Visitors per museum instance. `joinOrCreate` opens a second hall once this
 * fills, so it is set well above what a kiosk venue plus the public site draw
 * at once — past it, visitors simply stop seeing everyone.
 */
const MAX_VISITORS = 50;

/**
 * Position patches go out twenty times a second. Clients report at 10 Hz and
 * draw each other 200 ms in the past (snapshot interpolation); a patch rate
 * faster than the report rate keeps the server from adding up to a whole report
 * interval of jitter on top. At 50 visitors of ~20 bytes that is a few KB/s.
 */
const PATCH_RATE_MS = 50;

/** No coordinate in the museum is anywhere near this; anything past it is garbage. */
const WORLD_LIMIT = 10_000;

/**
 * The Exhibition Museum's presence room: who else is walking the hall, and where.
 *
 * Not a `BaseGameRoom`. There is no match here — no seat, host, start, room code,
 * reconnection window or persisted result — so none of that lifecycle applies.
 * Every client `joinOrCreate`s the one public `museum` room, reports its own
 * position with `move`, and renders everyone else from `state.visitors`.
 *
 * A visitor enters `visitors` on their first valid `move`, not on join: until the
 * server has heard where they stand, the others would otherwise draw them at the
 * world origin for a frame. They leave the map the moment their socket closes —
 * a dropped visitor who comes back joins afresh.
 *
 * The server does not check that a position is reachable. Where a visitor stands
 * decides nothing, so it is trusted the way a nameplate is; it is only bounded so
 * a malformed payload cannot put a NaN into everyone's state.
 */
export class MuseumRoom extends Room<{ state: MuseumState }> {
  maxClients = MAX_VISITORS;

  /** Names and avatars from join options, held until the visitor's first `move` creates their row. */
  private readonly names = new Map<string, string>();
  private readonly avatars = new Map<string, AvatarId>();

  messages = {
    move: function (this: MuseumRoom, client: Client, message: any) {
      this.handleMove(client, message);
    },
  };

  onCreate(_options: any) {
    this.state = new MuseumState();
    this.patchRate = PATCH_RATE_MS;
  }

  onJoin(client: Client, options: any) {
    this.names.set(client.sessionId, (options?.displayName ?? "").toString().slice(0, 32));
    this.avatars.set(client.sessionId, sanitizeAvatar(options?.avatar));
  }

  onLeave(client: Client) {
    this.names.delete(client.sessionId);
    this.avatars.delete(client.sessionId);
    this.state.visitors.delete(client.sessionId);
  }

  private handleMove(client: Client, message: any) {
    const x = Number(message?.x);
    const y = Number(message?.y);
    const z = Number(message?.z);
    const yaw = Number(message?.yaw);

    if (![x, y, z, yaw].every((n) => Number.isFinite(n) && Math.abs(n) <= WORLD_LIMIT)) {
      client.send("error", { code: "invalid_move", message: "move needs finite { x, y, z, yaw }." });
      return;
    }

    let visitor = this.state.visitors.get(client.sessionId);
    if (!visitor) {
      visitor = new MuseumVisitor();
      visitor.displayName = this.names.get(client.sessionId) ?? "";
      visitor.avatar = this.avatars.get(client.sessionId) ?? sanitizeAvatar(undefined);
      this.state.visitors.set(client.sessionId, visitor);
    }

    visitor.x = x;
    visitor.y = y;
    visitor.z = z;
    visitor.yaw = ((yaw % 360) + 360) % 360;
  }
}
