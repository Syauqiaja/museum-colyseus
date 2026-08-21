import { Client } from "colyseus";
import { BaseGameRoom } from "./BaseGameRoom.js";
import { EgrangRacer, EgrangState } from "./schema/EgrangState.js";
import { DEFAULT_FINISH_UNITS, EgrangRace } from "../games/egrang/EgrangRace.js";
import { seatLeft } from "../db/sessions.js";

/**
 * Egrang — 3-player stilt race.
 *
 * Room + lobby only comes from BaseGameRoom: seating, host, start, reconnect and
 * idle cleanup. Three seats, and the host may start with two — which is the
 * reason `start_game` exists at all. A room that fills to three starts on its own.
 *
 * A racer row is created lazily by `racerFor` — either when a seated client sends
 * `choose_stick` in the lobby, or for any seat that hasn't chosen one yet when
 * `onGameStart` fires — so a stilt chosen while waiting survives into the race.
 * `onGameStart` also reconciles `racers` against the still-seated players (a
 * choice made by someone who then left before the race started must not leave a
 * ghost row behind), arms the countdown and broadcasts it. Clients render that
 * countdown as the stilt-picking window; `countdown_sync` re-serves it to anyone
 * who joined the room's message stream after the broadcast went out.
 *
 * A stilt may be chosen while `waiting`, and it stays choosable into `in_progress`
 * right up until that racer's first accepted step: the room fills and auto-starts
 * (`BaseGameRoom.onJoin` at `maxClients`) before the Unity client has even loaded
 * the Egrang scene, so in real play `choose_stick` almost always arrives after the
 * race has started. Since the stilt only sets the difficulty of that racer's own
 * skill-check bar — never what a step is worth — accepting it late costs nothing.
 * It locks the moment that racer has banked a step, so it can't retarget the
 * difficulty mid-race.
 */
export class EgrangRoom extends BaseGameRoom<EgrangState> {
  maxClients = 3;
  protected minPlayers = 2;

  /**
   * Countdown before steps count. Shortened by tests.
   *
   * This is the stilt-picking window, not a "get ready" beat: the room auto-starts the
   * moment it fills (`BaseGameRoom.onJoin`), typically before a client has finished
   * loading the Egrang scene, so the countdown is the only time anyone gets to look at
   * the three poles. Clients render it from the `countdown` message below and take the
   * highlighted pole automatically when it runs out.
   */
  protected countdownMs = 15000;

  private race?: EgrangRace;

  messages = {
    choose_stick: function (this: EgrangRoom, client: Client, message: any) {
      this.handleChooseStick(client, message);
    },
    step: function (this: EgrangRoom, client: Client, message: any) {
      this.handleStep(client, message);
    },
    countdown_sync: function (this: EgrangRoom, client: Client) {
      this.sendCountdown(client);
    },
  };

  protected createInitialState(): EgrangState {
    return new EgrangState();
  }

  protected onRoomCreated(_options: any): void {
    this.state.finishUnits = DEFAULT_FINISH_UNITS;
  }

  protected onGameStart(): void {
    // A stilt chosen while waiting already has a racer row; anyone who hasn't
    // chosen yet gets one created now.
    const seatedSessionIds = [...this.state.players.keys()];
    for (const sessionId of seatedSessionIds) this.racerFor(sessionId);

    // A racer row created for someone who then left before the race started
    // would otherwise survive as a ghost: BaseGameRoom.onLeave only knows about
    // state.players, not racers.
    const seated = new Set(seatedSessionIds);
    for (const sessionId of [...this.state.racers.keys()]) {
      if (!seated.has(sessionId)) this.state.racers.delete(sessionId);
    }

    this.race = new EgrangRace(seatedSessionIds, this.state.finishUnits);
    this.state.startsAtMs = Date.now() + this.countdownMs;
    this.race.arm(this.state.startsAtMs);

    // `startsAtMs` is a server wall-clock stamp, so a client cannot turn it into "seconds
    // left" without trusting its own clock — a kiosk with a badly-set clock would show a
    // wrong countdown. The remaining milliseconds are computed here instead, once at the
    // start for whoever is already connected, and again per client on `countdown_sync`
    // for the usual case: a client that was still loading the scene when this fired.
    this.broadcast("countdown", {
      startsAtMs: this.state.startsAtMs,
      remainingMs: this.countdownMs,
    });
  }

  /** Tells one client how long is left before steps count. 0 outside a running countdown. */
  private sendCountdown(client: Client): void {
    const remainingMs = this.state.phase === "in_progress"
      ? Math.max(0, this.state.startsAtMs - Date.now())
      : 0;

    client.send("countdown", { startsAtMs: this.state.startsAtMs, remainingMs });
  }

  protected onOpponentLeft(_client: Client): void {
    // The base has already written the forfeit. A departed racer simply stops
    // stepping; the first racer home ends it for the rest.
  }

  /**
   * `BaseGameRoom.onLeave` is 2-player Dakon logic: it ends the match the moment
   * anyone leaves mid-game. That is wrong for a 3-seat race — if two racers are
   * still seated after someone drops out, the race must go on for them.
   *
   * When at least two seated players remain, this replicates only the seat-
   * bookkeeping half of the base behaviour (remove the player, broadcast
   * `player_left`, record the departure, migrate host) and withdraws the racer
   * from the engine so `allPlaced` no longer waits on someone who will never
   * step again — the survivors reach a normal `game_over` when one of them
   * crosses the line. It deliberately does NOT call
   * `persistMatchEnd`/`onOpponentLeft`: the match isn't over yet, and `finish()`
   * (which does persist, exactly once — see its `matchId` guard) is the only
   * path that should close it.
   *
   * The departed racer's `state.racers` row is left as-is rather than deleted:
   * remaining clients keep rendering their frozen last-known position instead
   * of the row vanishing mid-race. It also means that racer is not part of
   * `collectResults()` for the eventual persisted match-end (that walks
   * `state.players`, which no longer has them) — same as any player who is no
   * longer seated by the time the match closes.
   *
   * When fewer than two players would remain, this falls straight through to
   * `super.onLeave`, so a race that empties out still forfeits/abandons and
   * persists exactly as it does today.
   */
  onLeave(client: Client): void {
    if (this.state.phase !== "in_progress" || this.state.players.size - 1 < 2) {
      super.onLeave(client);
      return;
    }

    this.race?.withdraw(client.sessionId);

    this.state.players.delete(client.sessionId);
    this.broadcast("player_left", { sessionId: client.sessionId });
    void seatLeft(client.sessionId);

    if (this.state.hostSessionId === client.sessionId) {
      const next = this.state.players.keys().next();
      this.state.hostSessionId = next.done ? "" : next.value;
    }

    if (this.race?.allPlaced) {
      this.finish();
    }
  }

  protected scoreOf(sessionId: string): number {
    return this.race?.unitsOf(sessionId) ?? 0;
  }

  /** The racer row for a seat, created on first use so lobby-time choices have somewhere to land. */
  private racerFor(sessionId: string): EgrangRacer {
    let racer = this.state.racers.get(sessionId);
    if (!racer) {
      racer = new EgrangRacer();
      this.state.racers.set(sessionId, racer);
    }
    return racer;
  }

  private handleChooseStick(client: Client, message: any) {
    if (this.state.phase === "finished") {
      this.sendError(client, "invalid_move", "The race is over.");
      return;
    }

    if (this.state.phase === "in_progress") {
      const existing = this.state.racers.get(client.sessionId);
      if (existing && (existing.stepUnits > 0 || existing.place > 0)) {
        this.sendError(client, "invalid_move", "The stilt cannot change once you have started stepping.");
        return;
      }
    }

    const shape = Number(message?.shape);
    if (!Number.isInteger(shape) || shape < 0 || shape > 2) {
      this.sendError(client, "invalid_move", "choose_stick needs { shape: 0 | 1 | 2 }.");
      return;
    }

    const racer = this.racerFor(client.sessionId);
    racer.stick = shape;
    racer.ready = true;
  }

  private handleStep(client: Client, message: any) {
    const race = this.race;

    if (!race || this.state.phase !== "in_progress") {
      this.sendError(client, "invalid_move", "No race is running.");
      return;
    }

    const result = Number(message?.result);
    const outcome = race.step(client.sessionId, result, Date.now());

    if ("reason" in outcome) {
      this.sendError(client, "invalid_move", this.rejectMessage(outcome.reason));
      return;
    }

    const racer = this.state.racers.get(client.sessionId)!;
    racer.stepUnits = outcome.stepUnits;
    racer.place = outcome.place;

    this.broadcast("step_taken", {
      sessionId: client.sessionId,
      result,
      stepUnits: outcome.stepUnits,
    });

    // First one home ends the race for everyone: the others keep whatever place
    // they had already taken (0 for anyone still running), and the results panel
    // reads as "the race is over" rather than "wait and see". `allPlaced` is
    // still checked because a three-way race can place its last racer without
    // that racer being the first one home.
    if (outcome.place === 1 || race.allPlaced) {
      this.finish();
    }
  }

  /** Closes the race exactly once: the first racer home and the last one both land here. */
  private finish(): void {
    if (!this.race || this.state.phase === "finished") return;

    this.state.phase = "finished";

    const winner = this.race.winner;
    void this.persistMatchEnd("completed", this.collectResults(), winner);
    this.broadcast("game_over", { places: this.race.places(), winner });
  }

  private rejectMessage(reason: string): string {
    switch (reason) {
      case "not_seated": return "You are not racing in this match.";
      case "not_started": return "The race has not started yet.";
      case "bad_result": return "step needs { result: 0 | 1 | 2 }.";
      case "too_soon": return "That step came too soon after the last one.";
      default: return "You have already finished.";
    }
  }
}
