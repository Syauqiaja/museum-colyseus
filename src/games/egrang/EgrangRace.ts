/** How many strides an outcome is worth: fail 0, half 1, full 2. */
export function stepsFor(result: number): number {
  return result === 2 ? 2 : result === 1 ? 1 : 0;
}

export type StepReject =
  | "not_seated"
  | "not_started"
  | "bad_result"
  | "too_soon"
  | "already_placed";

export type StepOutcome =
  | { ok: true; stepUnits: number; place: number }
  | { ok: false; reason: StepReject };

/** Shortest gap between two accepted presses. The bar's own lockout is 600 ms. */
export const MIN_STEP_INTERVAL_MS = 500;

/** Race length in strides: 25 m of lane at 0.5 m a stride. */
export const DEFAULT_FINISH_UNITS = 50;

interface Racer {
  units: number;
  place: number;
  lastStepMs: number;
  /** Left the room mid-race. Excluded from `allPlaced` so the survivors aren't stuck
   *  waiting on a racer who will never step again. */
  withdrawn: boolean;
}

/**
 * Egrang race bookkeeping — see docs/games/egrang.md.
 *
 * Deliberately knows nothing about Colyseus or about world coordinates: it counts
 * strides and hands out places, so the whole ruleset can be tested without a server.
 * The client grades its own press; this class bounds how often one may arrive.
 */
export class EgrangRace {
  private readonly racers = new Map<string, Racer>();
  private startsAtMs = Number.POSITIVE_INFINITY;
  private nextPlace = 1;
  private firstFinish: number | null = null;

  constructor(sessionIds: readonly string[], readonly finishUnits: number = DEFAULT_FINISH_UNITS) {
    for (const sessionId of sessionIds) {
      this.racers.set(sessionId, {
        units: 0,
        place: 0,
        lastStepMs: Number.NEGATIVE_INFINITY,
        withdrawn: false,
      });
    }
  }

  /** Opens the race at a wall-clock instant. Steps before it do not count. */
  arm(startsAtMs: number): void {
    this.startsAtMs = startsAtMs;
  }

  /**
   * Marks a racer as gone for good (left the room mid-race). Their last banked
   * units/place are kept for `places()`/`winner`, but they no longer block
   * `allPlaced` — the survivors can still finish normally.
   */
  withdraw(sessionId: string): void {
    const racer = this.racers.get(sessionId);
    if (racer) racer.withdrawn = true;
  }

  step(sessionId: string, result: number, nowMs: number): StepOutcome {
    const racer = this.racers.get(sessionId);
    if (!racer) return { ok: false, reason: "not_seated" };
    if (nowMs < this.startsAtMs) return { ok: false, reason: "not_started" };
    if (!Number.isInteger(result) || result < 0 || result > 2) return { ok: false, reason: "bad_result" };
    if (racer.place > 0) return { ok: false, reason: "already_placed" };
    if (nowMs - racer.lastStepMs < MIN_STEP_INTERVAL_MS) return { ok: false, reason: "too_soon" };

    racer.lastStepMs = nowMs;
    racer.units = Math.min(racer.units + stepsFor(result), this.finishUnits);

    if (racer.units >= this.finishUnits) {
      racer.place = this.nextPlace++;
      this.firstFinish ??= nowMs;
    }

    return { ok: true, stepUnits: racer.units, place: racer.place };
  }

  unitsOf(sessionId: string): number {
    return this.racers.get(sessionId)?.units ?? 0;
  }

  placeOf(sessionId: string): number {
    return this.racers.get(sessionId)?.place ?? 0;
  }

  get allPlaced(): boolean {
    let counted = false;
    for (const racer of this.racers.values()) {
      if (racer.withdrawn) continue;
      counted = true;
      if (racer.place === 0) return false;
    }
    return counted;
  }

  /** When the first racer crossed, or null while nobody has. Drives the straggler timeout. */
  get firstFinishMs(): number | null {
    return this.firstFinish;
  }

  get winner(): string | null {
    for (const [sessionId, racer] of this.racers) if (racer.place === 1) return sessionId;
    return null;
  }

  places(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [sessionId, racer] of this.racers) out[sessionId] = racer.place;
    return out;
  }
}
