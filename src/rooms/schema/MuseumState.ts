import { MapSchema, Schema, type } from "@colyseus/schema";

/**
 * One visitor walking the exhibition hall, as the others see them. World units
 * are the Unity client's metres; `yaw` is the body's heading in degrees, 0..360.
 */
export class MuseumVisitor extends Schema {
  @type("string") displayName: string = "";
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("float32") z: number = 0;
  @type("float32") yaw: number = 0;

  /** Which character the visitor wears — one of `AVATAR_IDS` (src/rooms/avatars.ts). Last, so older fields keep their index. */
  @type("string") avatar: string = "jawa";
}

/**
 * The museum presence room — see docs/protocol.md#exhibition-museum-scene.
 *
 * Deliberately not a `BaseGameState`: there is no phase, host or seat, because
 * walking the hall is not a match. The Unity client mirrors this file as
 * `Museum.Net.State.MuseumState` / `MuseumVisitor`; field order is the wire
 * format, so regenerate the client after any change here.
 */
export class MuseumState extends Schema {
  /** Visitors who have reported a position, keyed by sessionId. */
  @type({ map: MuseumVisitor }) visitors = new MapSchema<MuseumVisitor>();
}
