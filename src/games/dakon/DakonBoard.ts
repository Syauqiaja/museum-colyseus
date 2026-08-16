import { DAKON_DEFAULTS, totalHoles, type DakonConfig } from "./DakonConfig.js";

/**
 * Dakon rules engine (v6 ruleset) — plain TypeScript, no Colyseus types.
 *
 * Port of the client's `DakonBoard.cs`, which is the ground-truth implementation of
 * the ruleset. Kept free of room/lifecycle concerns so it can be unit-tested
 * without booting a server, exactly as its C# twin is tested without a Unity scene.
 *
 * Ruleset in one paragraph: a ring of `holesPerSide * 2` holes, each typed monocot
 * or dicot (shuffled per side, `dicotPerSide` of them dicot). The active player
 * grabs `grabSize` random seeds from the centre pool and drops them one at a time
 * into consecutive holes, starting at their side's first hole and wrapping around
 * the ring — so a long hand does spill onto the opponent's side. Each drop is swept
 * immediately: seed category matches the hole's type → a point for the dropper,
 * otherwise a point for the opponent. When the hand empties, the turn passes; when
 * the pool is empty too, the game ends and the larger storehouse wins (ties are
 * allowed).
 *
 * Determinism: seeded PRNG, so a given seed always produces the same board and
 * draws. The stream is not byte-compatible with C#'s `System.Random` — it does not
 * need to be, because the server is authoritative and the client renders what it
 * is told rather than re-simulating.
 */

export type SeedCategory = "monocot" | "dicot";

export type DakonPhase = "waiting" | "in_progress" | "finished";

export type DakonErrorCode = "not_your_turn" | "invalid_hole" | "seed_not_in_hand";

export interface Seed {
  id: string;
  category: SeedCategory;
  /** Species id — cosmetic; only `category` scores. */
  typeId: string;
}

export interface DropResult {
  ok: boolean;
  error?: DakonErrorCode;

  /** Seat index (0/1) that received the point. */
  scoringPlayer: number;
  /** Store the seed landed in — always the seed's own category. */
  scoringCategory: SeedCategory;
  /** true = the dropper matched the hole; false = the opponent scored it. */
  wasMatch: boolean;
  /** The hand emptied on this drop. */
  turnEnded: boolean;
  /** The pool emptied after this turn's final drop. */
  gameOver: boolean;
}

function fail(error: DakonErrorCode): DropResult {
  return {
    ok: false,
    error,
    scoringPlayer: -1,
    scoringCategory: "monocot",
    wasMatch: false,
    turnEnded: false,
    gameOver: false,
  };
}

/** mulberry32 — small, fast, seedable. Enough for shuffling a board. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DakonBoard {
  private readonly config: DakonConfig;
  private readonly random: () => number;

  private holes: SeedCategory[] = [];
  private pool: Seed[] = [];
  private hand: Seed[] = [];

  /** Scored seed counts, `[seat][category]`. */
  private readonly stores: Record<SeedCategory, number>[] = [
    { monocot: 0, dicot: 0 },
    { monocot: 0, dicot: 0 },
  ];

  private activeSeat = 0;
  private nextHole = 0;
  private currentPhase: DakonPhase = "waiting";

  private monocotCursor = 0;
  private dicotCursor = 0;

  constructor(rngSeed: number, config: Partial<DakonConfig> = {}) {
    this.config = { ...DAKON_DEFAULTS, ...config };
    this.random = makeRng(rngSeed);
  }

  // --- setup ---------------------------------------------------------------

  start(): void {
    this.holes = new Array(totalHoles(this.config));
    this.rollSide(0);
    this.rollSide(1);
    this.fillPool();

    this.activeSeat = 0;
    this.nextHole = this.startHoleFor(this.activeSeat);
    this.currentPhase = "in_progress";
    this.grabHand();
  }

  /** Each side gets exactly `dicotPerSide` dicot holes, shuffled independently. */
  private rollSide(side: number): void {
    const per = this.config.holesPerSide;
    const base = side * per;

    const types: SeedCategory[] = [];
    for (let i = 0; i < per; i++) {
      types.push(i < this.config.dicotPerSide ? "dicot" : "monocot");
    }
    this.shuffle(types);

    for (let i = 0; i < per; i++) {
      this.holes[base + i] = types[i];
    }
  }

  private fillPool(): void {
    this.pool = [];
    const total = this.config.poolSeeds;
    const monocot = Math.floor((total + 1) / 2); // an odd pool gets the extra monocot

    for (let i = 0; i < total; i++) {
      const category: SeedCategory = i < monocot ? "monocot" : "dicot";
      this.pool.push({ id: `s${i}`, category, typeId: this.nextTypeId(category) });
    }
  }

  private nextTypeId(category: SeedCategory): string {
    const set =
      category === "monocot" ? this.config.monocotTypeIds : this.config.dicotTypeIds;

    if (set.length === 0) return category;

    const cursor = category === "monocot" ? this.monocotCursor++ : this.dicotCursor++;
    return set[cursor % set.length];
  }

  /** Take min(grabSize, poolRemaining) random seeds from the pool into the hand. */
  private grabHand(): void {
    this.hand = [];
    const take = Math.min(this.config.grabSize, this.pool.length);

    for (let i = 0; i < take; i++) {
      const index = Math.floor(this.random() * this.pool.length);
      this.hand.push(this.pool[index]);
      this.pool.splice(index, 1);
    }
  }

  private startHoleFor(seat: number): number {
    return seat === 0 ? 0 : this.config.holesPerSide;
  }

  private shuffle<T>(list: T[]): void {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  // --- play ----------------------------------------------------------------

  /**
   * Drop one held seed into the forced next hole. Every rejection is a rule, not
   * an exception: the caller turns the returned error code into an `error` message.
   */
  drop(seat: number, seedId: string, holeIndex: number): DropResult {
    if (this.currentPhase !== "in_progress") return fail("invalid_hole");
    if (seat !== this.activeSeat) return fail("not_your_turn");
    if (holeIndex !== this.nextHole) return fail("invalid_hole");

    const handIndex = this.hand.findIndex((s) => s.id === seedId);
    if (handIndex < 0) return fail("seed_not_in_hand");

    const seed = this.hand[handIndex];
    const wasMatch = seed.category === this.holes[holeIndex];
    const scoringPlayer = wasMatch ? this.activeSeat : 1 - this.activeSeat;

    this.stores[scoringPlayer][seed.category]++;
    this.hand.splice(handIndex, 1);
    this.nextHole = (this.nextHole + 1) % totalHoles(this.config);

    const result: DropResult = {
      ok: true,
      scoringPlayer,
      scoringCategory: seed.category,
      wasMatch,
      turnEnded: false,
      gameOver: false,
    };

    if (this.hand.length === 0) {
      result.turnEnded = true;

      if (this.pool.length === 0) {
        this.currentPhase = "finished";
        result.gameOver = true;
      } else {
        this.activeSeat = 1 - this.activeSeat;
        this.nextHole = this.startHoleFor(this.activeSeat);
        this.grabHand();
      }
    }

    return result;
  }

  // --- read-only accessors -------------------------------------------------

  get phase(): DakonPhase {
    return this.currentPhase;
  }

  get activePlayer(): number {
    return this.activeSeat;
  }

  get nextHoleIndex(): number {
    return this.nextHole;
  }

  get poolCount(): number {
    return this.pool.length;
  }

  get holeCount(): number {
    return this.holes.length;
  }

  get currentHand(): readonly Seed[] {
    return this.hand;
  }

  get holeTypes(): readonly SeedCategory[] {
    return this.holes;
  }

  store(seat: number, category: SeedCategory): number {
    return this.stores[seat][category];
  }

  total(seat: number): number {
    return this.stores[seat].monocot + this.stores[seat].dicot;
  }

  /** Seat 0/1 once finished, or null for a tie (and while still playing). */
  get winner(): number | null {
    if (this.currentPhase !== "finished") return null;

    const a = this.total(0);
    const b = this.total(1);
    if (a > b) return 0;
    if (b > a) return 1;
    return null;
  }
}
