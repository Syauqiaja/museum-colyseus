import { Client, Room } from "colyseus";
import { MuseumState, MuseumVisitor } from "./schema/MuseumState.js";

/** Visitors one hub room holds before matchmaking opens a second one. */
export const MUSEUM_MAX_VISITORS = 32;

/** How often visitor positions go out, in ms. 10 Hz is plenty for a walking avatar. */
export const MUSEUM_PATCH_MS = 100;

/**
 * Half-extent of the box a reported position must fall inside. Generous on purpose —
 * it is a sanity bound against garbage, not a collision check; the museum is roughly
 * 60 × 60 m and two floors tall.
 */
export const MUSEUM_BOUNDS = { x: 200, y: 100, z: 200 } as const;

/**
 * Museum — the exhibition hub's presence room. See docs/protocol.md#exhibition-museum-scene.
 *
 * Not a `BaseGameRoom`: there is no match here. Nobody is host, nothing starts, nothing
 * is scored or persisted, and a visitor may walk in and out at any time. The only thing
 * the room does is relay where everyone is, so avatars can be drawn for one another.
 *
 * The client sends `move` at its own cadence (a few times a second); the room copies
 * the numbers into that visitor's row after checking they are finite and inside the
 * building, and the schema patch carries them to everyone else. The server does not
 * simulate walking — the museum has no rules to enforce, so "is authoritative" here
 * only means "is the single copy everyone reads".
 *
 * Public matchmaking (`joinOrCreate("museum")`) is the only join flow: rooms fill to
 * `MUSEUM_MAX_VISITORS` and a second one opens by itself. Visitors in different rooms
 * do not see each other, which is acceptable for a hub and the same trade every open
 * world makes.
 */
export class MuseumRoom extends Room<{ state: MuseumState }> {
  maxClients = MUSEUM_MAX_VISITORS;

  messages = {
    move: function (this: MuseumRoom, client: Client, message: any) {
      this.handleMove(client, message);
    },
  };

  onCreate(_options: any) {
    this.state = new MuseumState();
    this.patchRate = MUSEUM_PATCH_MS;
  }

  onJoin(client: Client, options: any) {
    const visitor = new MuseumVisitor();
    visitor.displayName = (options?.displayName ?? "").toString().slice(0, 32);
    this.state.visitors.set(client.sessionId, visitor);
  }

  /**
   * No reconnection window. A visitor who drops is gone from the hub the moment the
   * socket closes; if the page reloads they join again as a new visitor, and nobody
   * was keeping a seat for them.
   */
  onLeave(client: Client) {
    this.state.visitors.delete(client.sessionId);
  }

  private handleMove(client: Client, message: any) {
    const visitor = this.state.visitors.get(client.sessionId);
    if (!visitor) return;

    const x = Number(message?.x);
    const y = Number(message?.y);
    const z = Number(message?.z);
    const yaw = Number(message?.yaw);

    // Garbage is dropped, not answered: a `move` that fails is not a rule broken,
    // and an error toast in the hub would only tell a visitor about a bug they
    // cannot act on.
    if (!isInside(x, MUSEUM_BOUNDS.x) || !isInside(y, MUSEUM_BOUNDS.y) || !isInside(z, MUSEUM_BOUNDS.z)) return;
    if (!Number.isFinite(yaw)) return;

    visitor.x = x;
    visitor.y = y;
    visitor.z = z;
    visitor.yaw = ((yaw % 360) + 360) % 360;
  }
}

function isInside(value: number, halfExtent: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= halfExtent;
}
