import { Schema, type } from "@colyseus/schema";

/**
 * A player seated in a game room. Shared by every game type — game-specific
 * per-player fields (scores, hands, positions) belong on a subclass or on the
 * game's own state, not here.
 */
export class BasePlayer extends Schema {
  @type("string") sessionId: string = "";
  @type("string") displayName: string = "";

  /**
   * 0-based seat index, assigned on join and reused once a seat is vacated. Games
   * map it to sides (Dakon: seat 0 = player 0) and the client renders lobby slots
   * in this order.
   *
   * The stable profile GUID a client may send is deliberately **not** here: it is
   * a stats key held server-side, not something peers should be able to read.
   */
  @type("uint8") seat: number = 0;

  /** false while the player is dropped and inside the reconnection window. */
  @type("boolean") connected: boolean = true;

  /**
   * Which character the player wears — one of `AVATAR_IDS` (src/rooms/avatars.ts),
   * from the `avatar` join option. Cosmetic: the Egrang lanes render it. Declared
   * last so every older field keeps its index in both games' decoders.
   */
  @type("string") avatar: string = "jawa";
}
