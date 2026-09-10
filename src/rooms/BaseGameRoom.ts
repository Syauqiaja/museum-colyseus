import { Room, Client, ServerError } from "colyseus";
import type { Delayed } from "@colyseus/timer";
import { BaseGameState } from "./schema/BaseGameState.js";
import { BasePlayer } from "./schema/BasePlayer.js";
import { sanitizeAvatar } from "./avatars.js";
import { sanitizePlayerId, touchPlayer } from "../db/players.js";
import {
  finishMatch,
  startMatch,
  type MatchOutcome,
  type MatchPlayerResult,
} from "../db/matches.js";
import { roomClosed, seatConnectionChanged, seatJoined, seatLeft } from "../db/sessions.js";

/**
 * Room-code alphabet: uppercase letters + digits with visually ambiguous
 * characters removed (0/O, 1/I/L). Keeps 6-char codes easy to read and type
 * at a museum kiosk. See docs/room-system.md.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

/** Seconds a dropped player may reconnect before the seat is freed. */
const RECONNECT_SECONDS = 30;

/** A room still in the lobby ("waiting") after this long auto-destroys. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** ServerError codes surfaced to clients (see docs/protocol.md error contract). */
export const RoomErrorCode = {
  ALREADY_STARTED: 4001,
} as const;

/** `error` message codes this base emits. Games add their own. */
export const LobbyErrorCode = {
  NOT_HOST: "not_host",
  NOT_ENOUGH_PLAYERS: "not_enough_players",
  ALREADY_STARTED: "already_started",
} as const;

/**
 * Reusable base for every game room. Owns matchmaking/lifecycle concerns that
 * are identical across games — short room codes, private flag, the players map,
 * seat assignment, host assignment/migration, host-driven start, reconnection,
 * idle cleanup, join guards, and the persistence of who played what. A concrete
 * game (DakonRoom, ...) subclasses this, sets `maxClients`, and implements the
 * abstract hooks with its own state + rules.
 *
 * The three client join flows are near-native to Colyseus and need no custom
 * endpoint here:
 *  - private create:  client.create(name, { private: true, displayName, playerId })
 *  - public matchmaking: client.joinOrCreate(name, { displayName, playerId })
 *  - join by code:    client.joinById(code, { displayName, playerId })
 *
 * **Starting a match** is host-driven: the host sends `start_game` once at least
 * `minPlayers` are seated. A room that fills to `maxClients` also starts on its
 * own, because at that point there is nothing left to wait for. Egrang is why the
 * host needs the button at all — 3 seats that can start with 2.
 */
export abstract class BaseGameRoom<S extends BaseGameState> extends Room<{ state: S }> {
  /** Presence channel where active room codes are registered for collision checks. */
  private readonly LOBBY_CHANNEL = "$roomcodes";

  /** Seats needed before the host may start. Games with a wider range raise it. */
  protected minPlayers = 2;

  private idleTimer?: Delayed;

  /**
   * Client-supplied stable player GUIDs, by sessionId. Kept off the synced state
   * on purpose: peers have no business reading each other's profile id, and it is
   * a stats key, never an authorisation one.
   */
  private readonly playerIds = new Map<string, string | null>();

  /** Row id of the open `matches` record, once a match has started. */
  private matchId?: number;

  // --- hooks a concrete game must implement -------------------------------

  /** Fresh state instance for a new room. */
  protected abstract createInitialState(): S;

  /** Called at the end of onCreate, after state + code are set. */
  protected abstract onRoomCreated(options: any): void;

  /** Called once the match starts (host pressed start, or the room filled). */
  protected abstract onGameStart(): void;

  /**
   * Called when a player leaves for good (reconnection window expired or
   * consented leave) while a match was in progress — i.e. the match can no
   * longer continue. Implement forfeit/result logic here.
   */
  protected abstract onOpponentLeft(client: Client): void;

  /**
   * A seat's current score, for the results rows. Default 0 — a game with scores
   * (Dakon) overrides it so persisted results are the server's own numbers.
   */
  protected scoreOf(_sessionId: string): number {
    return 0;
  }

  // --- lifecycle -----------------------------------------------------------

  async onCreate(options: any) {
    this.roomId = await this.generateRoomId();

    if (options?.private) {
      await this.setPrivate(true);
    }

    this.state = this.createInitialState();
    this.state.phase = "waiting";

    // Host-driven start. Registered here rather than in a subclass `messages` map
    // so every game gets it without repeating the guards.
    this.onMessage("start_game", (client) => this.handleStartRequest(client));

    // Auto-destroy the room if it sits empty/waiting too long.
    this.idleTimer = this.clock.setTimeout(() => {
      if (this.state.phase === "waiting") {
        this.disconnect();
      }
    }, IDLE_TIMEOUT_MS);

    this.onRoomCreated(options);
  }

  /**
   * Join guard. Colyseus already rejects full/locked rooms before this runs
   * (surfaced client-side as a join error → room_full). Here we additionally
   * reject joins into a match that has already started.
   */
  onAuth(_client: Client, _options: any): boolean {
    if (this.state.phase !== "waiting") {
      throw new ServerError(RoomErrorCode.ALREADY_STARTED, "already_started");
    }
    return true;
  }

  onJoin(client: Client, options: any) {
    const displayName = (options?.displayName ?? "").toString().slice(0, 32);
    const playerId = sanitizePlayerId(options?.playerId);

    const player = new BasePlayer();
    player.sessionId = client.sessionId;
    player.displayName = displayName;
    player.avatar = sanitizeAvatar(options?.avatar);
    player.connected = true;
    player.seat = this.nextFreeSeat();
    this.state.players.set(client.sessionId, player);
    this.playerIds.set(client.sessionId, playerId);

    if (!this.state.hostSessionId) {
      this.state.hostSessionId = client.sessionId;
    }

    this.broadcast("player_joined", { sessionId: client.sessionId });

    // Best-effort persistence — see src/db/pool.ts: a database outage must not
    // touch the match. Deliberately not awaited; onJoin should not block on I/O.
    void touchPlayer(playerId, displayName);
    void seatJoined({
      sessionId: client.sessionId,
      roomId: this.roomId,
      game: this.roomName,
      playerId,
      displayName,
      seat: player.seat,
    });

    if (this.clients.length >= this.maxClients) {
      this.startGame();
    }
  }

  /** Unexpected disconnect: hold the seat open for a reconnection window. */
  async onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.connected = false;
    }
    void seatConnectionChanged(client.sessionId, false);

    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
      // resolved → onReconnect() fires; nothing else to do here.
    } catch {
      // window expired / rejected → onLeave() will finalize the departure.
    }
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.connected = true;
    }
    void seatConnectionChanged(client.sessionId, true);
  }

  /** Player has left for good. */
  onLeave(client: Client) {
    const wasInProgress = this.state.phase === "in_progress";

    // Snapshot before the seat is removed: the results rows must still name the
    // player who walked out.
    const results = wasInProgress ? this.collectResults() : [];

    this.state.players.delete(client.sessionId);
    this.broadcast("player_left", { sessionId: client.sessionId });
    void seatLeft(client.sessionId);

    // Migrate host to any remaining player.
    if (this.state.hostSessionId === client.sessionId) {
      const next = this.state.players.keys().next();
      this.state.hostSessionId = next.done ? "" : next.value;
    }

    if (wasInProgress) {
      this.state.phase = "finished";
      // The remaining player wins by forfeit; with nobody left it is abandoned.
      const remaining = results.filter((r) => r.sessionId !== client.sessionId);
      void this.persistMatchEnd(
        remaining.length === 1 ? "forfeited" : "abandoned",
        results,
        remaining.length === 1 ? remaining[0].sessionId : null,
      );
      this.onOpponentLeft(client);
    }
    // Room auto-disposes once the last client is gone.
  }

  onDispose() {
    this.idleTimer?.clear();
    void roomClosed(this.roomId);
    this.playerIds.clear();
    return this.presence.srem(this.LOBBY_CHANNEL, this.roomId);
  }

  // --- start ---------------------------------------------------------------

  /**
   * `start_game` from a client. Rejected with an `error` message rather than a
   * thrown ServerError: the player is already in the room and stays there — only
   * the request failed. Codes match the client's LobbyError set.
   */
  private handleStartRequest(client: Client) {
    if (this.state.phase !== "waiting") {
      this.sendError(client, LobbyErrorCode.ALREADY_STARTED, "The match has already started.");
      return;
    }

    if (client.sessionId !== this.state.hostSessionId) {
      this.sendError(client, LobbyErrorCode.NOT_HOST, "Only the host can start the match.");
      return;
    }

    if (this.state.players.size < this.minPlayers) {
      this.sendError(
        client,
        LobbyErrorCode.NOT_ENOUGH_PLAYERS,
        `Needs at least ${this.minPlayers} players.`,
      );
      return;
    }

    this.startGame();
  }

  private startGame() {
    if (this.state.phase !== "waiting") return;

    this.state.phase = "in_progress";
    this.lock();
    this.idleTimer?.clear();

    void this.persistMatchStart();
    this.onGameStart();
  }

  // --- results -------------------------------------------------------------

  /**
   * Close the match rows with a final result. Games call this from their own
   * end-of-game path (Dakon: pool exhausted); the base calls it itself when a
   * departure ends a match early.
   */
  protected async persistMatchEnd(
    outcome: MatchOutcome,
    results: readonly MatchPlayerResult[],
    winnerSessionId: string | null,
  ): Promise<void> {
    if (this.matchId === undefined) return;

    const matchId = this.matchId;
    this.matchId = undefined; // a match is closed once — a later leave must not reopen it
    await finishMatch(matchId, outcome, results, winnerSessionId);
  }

  /** Every seated player as a result row, with the game's current scores. */
  protected collectResults(): MatchPlayerResult[] {
    const rows: MatchPlayerResult[] = [];

    this.state.players.forEach((player, sessionId) => {
      rows.push({
        seat: player.seat,
        sessionId,
        playerId: this.playerIds.get(sessionId) ?? null,
        displayName: player.displayName,
        score: this.scoreOf(sessionId),
      });
    });

    return rows.sort((a, b) => a.seat - b.seat);
  }

  /** The stable profile id behind a seat, or null when the client sent none. */
  protected playerIdOf(sessionId: string): string | null {
    return this.playerIds.get(sessionId) ?? null;
  }

  private async persistMatchStart(): Promise<void> {
    this.matchId = await startMatch(this.roomId, this.roomName, this.collectResults());
  }

  // --- helpers -------------------------------------------------------------

  protected sendError(client: Client, code: string, message: string) {
    client.send("error", { code, message });
  }

  /**
   * Lowest seat index not currently taken. Seats are stable while a player is in
   * the room and reused after they leave, so a 3-seat room never renders a gap.
   */
  private nextFreeSeat(): number {
    const taken = new Set<number>();
    this.state.players.forEach((p) => taken.add(p.seat));

    for (let i = 0; i < this.maxClients; i++) {
      if (!taken.has(i)) return i;
    }

    return this.state.players.size;
  }

  private generateRoomIdSingle(): string {
    let result = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      result += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    return result;
  }

  /**
   * Generate a room code not currently in use, registering it with the
   * Presence API so concurrent rooms (across processes) don't collide.
   */
  private async generateRoomId(): Promise<string> {
    const current = await this.presence.smembers(this.LOBBY_CHANNEL);
    let id: string;
    do {
      id = this.generateRoomIdSingle();
    } while (current.includes(id));
    await this.presence.sadd(this.LOBBY_CHANNEL, id);
    return id;
  }
}
