import { Client, Room } from "colyseus";
import { MuseumState, MuseumVisitor } from "./schema/MuseumState.js";
import { type AvatarId, sanitizeAvatar } from "./avatars.js";
import { INTERACTS_PER_SECOND, isMuseumActivity, stationSlots } from "./museumStations.js";

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
 *
 * A visitor who walks through a doorway stays joined through the lobby and the
 * game, marked away with `activity`, so the others keep seeing them where they
 * left. Exhibits they set off (`interact`) are relayed to everyone else as
 * `interacted` — an event, not state: a visitor who arrives later missed that
 * gong strike, as they would have in the real hall.
 */
export class MuseumRoom extends Room<{ state: MuseumState }> {
  maxClients = MAX_VISITORS;

  /** Names and avatars from join options, held until the visitor's first `move` creates their row. */
  private readonly names = new Map<string, string>();
  private readonly avatars = new Map<string, AvatarId>();

  /** Accept times (ms) of each visitor's interactions in the last second. */
  private readonly interactTimes = new Map<string, number[]>();

  messages = {
    move: function (this: MuseumRoom, client: Client, message: any) {
      this.handleMove(client, message);
    },
    interact: function (this: MuseumRoom, client: Client, message: any) {
      this.handleInteract(client, message);
    },
    activity: function (this: MuseumRoom, client: Client, message: any) {
      this.handleActivity(client, message);
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
    this.interactTimes.delete(client.sessionId);
    this.state.visitors.delete(client.sessionId);
  }

  /**
   * An exhibit set off — `{ station, index }`. Relayed to everyone but the
   * sender, who has already played it. Only a listed visitor who is in the hall
   * (not away in a game) can set one off, and never faster than
   * `INTERACTS_PER_SECOND`.
   */
  private handleInteract(client: Client, message: any) {
    const station = (message?.station ?? "").toString();
    const index = Number(message?.index ?? 0);
    const slots = stationSlots(station);
    const visitor = this.state.visitors.get(client.sessionId);

    if (slots === 0 || !Number.isInteger(index) || index < 0 || index >= slots || !visitor || visitor.activity !== "") {
      client.send("error", {
        code: "invalid_interact",
        message: "interact needs a known { station, index } from a visitor in the hall.",
      });
      return;
    }

    const now = Date.now();
    const recent = (this.interactTimes.get(client.sessionId) ?? []).filter((t) => now - t < 1000);

    if (recent.length >= INTERACTS_PER_SECOND) {
      this.interactTimes.set(client.sessionId, recent);
      client.send("error", { code: "too_fast", message: `at most ${INTERACTS_PER_SECOND} interactions a second.` });
      return;
    }

    recent.push(now);
    this.interactTimes.set(client.sessionId, recent);
    this.broadcast("interacted", { sessionId: client.sessionId, station, index }, { except: client });
  }

  /** `{ game }` — `""` back in the hall, or the game room the visitor went to play. */
  private handleActivity(client: Client, message: any) {
    const game = (message?.game ?? "").toString();
    const visitor = this.state.visitors.get(client.sessionId);

    if (!isMuseumActivity(game) || !visitor) {
      client.send("error", { code: "invalid_activity", message: "activity needs a known { game } from a listed visitor." });
      return;
    }

    visitor.activity = game;
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
