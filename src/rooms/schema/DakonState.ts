import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";
import { BaseGameState } from "./BaseGameState.js";

/** One seed as the client sees it. `category` scores; `typeId` picks the sprite. */
export class DakonSeed extends Schema {
  @type("string") id: string = "";
  @type("string") category: string = "monocot";
  @type("string") typeId: string = "";
}

/** A seat's storehouse, split by category because the client renders two bins per side. */
export class DakonStore extends Schema {
  @type("uint16") monocot: number = 0;
  @type("uint16") dicot: number = 0;
  @type("uint16") total: number = 0;
}

/**
 * Dakon (Congklak) synced state — the v6 ruleset, mirroring the client's
 * `DakonBoard.cs`. See docs/games/dakon.md and docs/protocol.md#dakon.
 *
 * The hand is public rather than visible only to the active player: it is the
 * simplest server-authoritative shape, and the client already decides what to
 * render for whom. Holes carry only their *type* — a hole never holds seeds
 * between drops, because every drop is swept immediately.
 */
export class DakonState extends BaseGameState {
  /** Seeds still undrawn in the centre pool. The game ends when this hits 0. */
  @type("uint16") centerPoolCount: number = 0;

  /** Hole types in ring order: 0..holesPerSide-1 = seat 0's side, then seat 1's. */
  @type(["string"]) holes = new ArraySchema<string>();

  /** sessionId of the player whose turn it is. Empty until the match starts. */
  @type("string") activePlayer: string = "";

  /** Forced destination of the next drop — the client highlights it. */
  @type("uint8") nextHoleIndex: number = 0;

  /** The active player's undropped seeds, in draw order. */
  @type([DakonSeed]) hand = new ArraySchema<DakonSeed>();

  /** Storehouses, keyed by sessionId. */
  @type({ map: DakonStore }) storehouses = new MapSchema<DakonStore>();
}
