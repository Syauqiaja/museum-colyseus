import { Schema, MapSchema, type } from "@colyseus/schema";
import { BasePlayer } from "./BasePlayer.js";

export type GamePhase = "waiting" | "in_progress" | "finished";

/**
 * Base synced state every game room shares: lobby phase, host, and the seated
 * players. Each game subclasses this and adds its own fields (board, scores,
 * turn, ...) — `@colyseus/schema` supports inheritance, so the base fields sync
 * alongside the subclass fields.
 */
export class BaseGameState extends Schema {
  /** Lobby lifecycle. Starts "waiting", flips to "in_progress" on start. */
  @type("string") phase: GamePhase = "waiting";

  /** sessionId of the current host (first joiner; migrates if they leave). */
  @type("string") hostSessionId: string = "";

  @type({ map: BasePlayer }) players = new MapSchema<BasePlayer>();
}
