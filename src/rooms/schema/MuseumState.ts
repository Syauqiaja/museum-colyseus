import { MapSchema, Schema, type } from "@colyseus/schema";

/**
 * One visitor walking the exhibition hub. Position only — the museum has no rules, no
 * turns and no score, so nothing here is ever validated beyond "is a finite number in
 * the building". See docs/protocol.md#exhibition-museum-scene.
 */
export class MuseumVisitor extends Schema {
  @type("string") displayName: string = "";

  /** World position, in the client's scene units (metres). */
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("float32") z: number = 0;

  /** Body yaw in degrees, 0..360. Pitch is not shared: an avatar looks where it walks. */
  @type("float32") yaw: number = 0;
}

/**
 * The museum presence room's whole state. Deliberately **not** a `BaseGameState`: there is
 * no phase, no host and no seat in a hub that anyone may wander into and out of at any time,
 * and inheriting them would make the client wait for a "start" that never comes.
 */
export class MuseumState extends Schema {
  /** Everyone currently in the hub, keyed by sessionId. */
  @type({ map: MuseumVisitor }) visitors = new MapSchema<MuseumVisitor>();
}
