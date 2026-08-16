import { MapSchema, Schema, type } from "@colyseus/schema";
import { BaseGameState } from "./BaseGameState.js";

/** One seat's race standing. Distance is in strides, never metres — see docs/games/egrang.md. */
export class EgrangRacer extends Schema {
  /** Stilt: 0 persegi, 1 lingkaran, 2 segitiga. Difficulty only; it never changes what a step is worth. */
  @type("uint8") stick: number = 0;

  /** Strides banked so far, clamped to `finishUnits`. */
  @type("uint16") stepUnits: number = 0;

  /** 0 until the racer crosses, then 1..3 in finishing order. */
  @type("uint8") place: number = 0;

  /** Set once a stilt has been chosen. */
  @type("boolean") ready: boolean = false;
}

/**
 * Egrang — the three-lane stilt race. See docs/games/egrang.md and docs/protocol.md#egrang.
 *
 * `racers` is a second map rather than a re-typed `players`: the inherited map is
 * shared with Dakon, and re-declaring it would move field order in a base two games
 * depend on.
 */
export class EgrangState extends BaseGameState {
  /** Race standings, keyed by sessionId. */
  @type({ map: EgrangRacer }) racers = new MapSchema<EgrangRacer>();

  /** Race length in strides. */
  @type("uint16") finishUnits: number = 0;

  /** Wall-clock start. Steps before it do not count. */
  @type("number") startsAtMs: number = 0;
}
