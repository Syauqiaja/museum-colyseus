import { Client } from "colyseus";
import { BaseGameRoom } from "./BaseGameRoom.js";
import { DakonSeed, DakonState, DakonStore } from "./schema/DakonState.js";
import { DakonBoard, type DakonErrorCode } from "../games/dakon/DakonBoard.js";

/**
 * Dakon — turn-based 2-player Congklak.
 *
 * Matchmaking, seating and lifecycle come from BaseGameRoom; this class owns the
 * board. The rules live in `DakonBoard` (plain TS, unit-tested without a server) —
 * everything here is translation: message in → engine call → state mirrored out.
 *
 * Seats are the engine's player indices: seat 0 sows from hole 0, seat 1 from the
 * middle of the ring. `drop_seed` is the only client input, and it is validated by
 * the engine, never trusted (docs/boundaries.md).
 */
export class DakonRoom extends BaseGameRoom<DakonState> {
  maxClients = 2;
  protected minPlayers = 2;

  private board?: DakonBoard;

  /** sessionId by seat index, fixed at start so a mid-match leave can't reshuffle sides. */
  private seats: string[] = [];

  messages = {
    drop_seed: function (this: DakonRoom, client: Client, message: any) {
      this.handleDrop(client, message);
    },
  };

  protected createInitialState(): DakonState {
    return new DakonState();
  }

  protected onRoomCreated(_options: any): void {
    // Nothing beyond the base lobby until the match starts.
  }

  protected onGameStart(): void {
    // Seat order is the lobby's seat index, so "you are player 1/2" matches the
    // slot the player was shown while waiting.
    this.seats = [];
    this.state.players.forEach((player, sessionId) => {
      this.seats[player.seat] = sessionId;
    });

    const board = new DakonBoard(this.deriveSeed());
    board.start();
    this.board = board;

    this.state.holes.clear();
    board.holeTypes.forEach((type) => this.state.holes.push(type));

    this.seats.forEach((sessionId) => {
      this.state.storehouses.set(sessionId, new DakonStore());
    });

    this.syncBoard();
  }

  protected onOpponentLeft(_client: Client): void {
    // The base has already flipped the phase to "finished" and written the forfeit
    // result. Tell the remaining client why it stopped, with the same payload a
    // natural finish sends.
    this.broadcastGameOver();
  }

  /** Scores for the persisted result rows — the engine's numbers, not a client's. */
  protected scoreOf(sessionId: string): number {
    const seat = this.seats.indexOf(sessionId);
    return seat < 0 || !this.board ? 0 : this.board.total(seat);
  }

  // --- moves ---------------------------------------------------------------

  private handleDrop(client: Client, message: any) {
    const board = this.board;

    if (!board || this.state.phase !== "in_progress") {
      this.sendError(client, "invalid_move", "No match is in progress.");
      return;
    }

    const seat = this.seats.indexOf(client.sessionId);
    if (seat < 0) {
      this.sendError(client, "invalid_move", "You are not seated in this match.");
      return;
    }

    const seedId = typeof message?.seedId === "string" ? message.seedId : "";
    const holeIndex = Number(message?.holeIndex);

    if (!seedId || !Number.isInteger(holeIndex)) {
      this.sendError(client, "invalid_move", "drop_seed needs { seedId, holeIndex }.");
      return;
    }

    // Read before the drop, which removes the seed from the hand: the species id is the
    // client's cue for which 3D seed to throw, and by the time we have a result it is gone.
    const species = board.currentHand.find((s) => s.id === seedId)?.typeId ?? "";

    const result = board.drop(seat, seedId, holeIndex);

    if (!result.ok) {
      this.sendError(client, result.error!, this.errorMessage(result.error!));
      return;
    }

    this.syncBoard();

    // State says what the board *is*; this says what just happened, which is what an
    // animation needs. The client cannot reliably derive it from consecutive patches — a
    // turn-ending drop refills the hand in the same breath, so the patch after it shows a
    // bigger hand than before, and two drops inside one patch interval erase each other.
    this.broadcast("drop_applied", {
      seedId,
      holeIndex,
      scoringPlayer: result.scoringPlayer,
      category: result.scoringCategory,
      typeId: species,
      turnEnded: result.turnEnded,
      gameOver: result.gameOver,
    });

    if (result.gameOver) {
      this.finish();
    }
  }

  /** Mirror the engine into synced state. Cheap enough to do wholesale per drop. */
  private syncBoard(): void {
    const board = this.board!;

    this.state.centerPoolCount = board.poolCount;
    this.state.nextHoleIndex = board.nextHoleIndex;
    this.state.activePlayer = this.seats[board.activePlayer] ?? "";

    this.state.hand.clear();
    for (const seed of board.currentHand) {
      const synced = new DakonSeed();
      synced.id = seed.id;
      synced.category = seed.category;
      synced.typeId = seed.typeId;
      this.state.hand.push(synced);
    }

    this.seats.forEach((sessionId, seat) => {
      const store = this.state.storehouses.get(sessionId);
      if (!store) return;

      store.monocot = board.store(seat, "monocot");
      store.dicot = board.store(seat, "dicot");
      store.total = board.total(seat);
    });
  }

  /** Pool exhausted: close the match, persist the result, tell the clients. */
  private finish(): void {
    this.state.phase = "finished";

    const winnerSeat = this.board!.winner;
    const winnerSessionId = winnerSeat === null ? null : (this.seats[winnerSeat] ?? null);

    void this.persistMatchEnd("completed", this.collectResults(), winnerSessionId);
    this.broadcastGameOver();
  }

  /** `game_over` — { scores: { [sessionId]: number }, winner: string | null }. */
  private broadcastGameOver(): void {
    const scores: Record<string, number> = {};
    this.state.players.forEach((_player, sessionId) => {
      scores[sessionId] = this.scoreOf(sessionId);
    });

    const winnerSeat = this.board?.winner ?? null;

    this.broadcast("game_over", {
      scores,
      winner: winnerSeat === null ? null : (this.seats[winnerSeat] ?? null),
    });
  }

  private errorMessage(code: DakonErrorCode): string {
    switch (code) {
      case "not_your_turn":
        return "It is not your turn.";
      case "seed_not_in_hand":
        return "That seed is not in your hand.";
      default:
        return "That hole is not the next one in the sequence.";
    }
  }

  /**
   * Board seed. Derived from the room code so a match is reproducible from its
   * results row when someone reports a bad board, and so no client can choose it.
   */
  private deriveSeed(): number {
    let hash = 2166136261;
    for (const char of this.roomId) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
}
