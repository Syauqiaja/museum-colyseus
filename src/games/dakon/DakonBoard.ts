import {
  DAKON_DEFAULTS,
  totalHoles,
  type DakonConfig,
  type SeedCategory,
} from "./DakonConfig.js";

/**
 * Dakon rules engine (v7 ruleset) — plain TypeScript, no Colyseus types.
 *
 * Port of the client's `DakonBoard.cs`, which is the ground-truth implementation of
 * the ruleset. Kept free of room/lifecycle concerns so it can be unit-tested
 * without booting a server, exactly as its C# twin is tested without a Unity scene.
 *
 * Ruleset in one paragraph: a ring of `holesPerSide * 2` holes, each typed monocot
 * or dicot by the fixed `holeTypes` layout (five of each per side, pinned to the
 * icons painted on the client's board rather than rolled). The active player
 * grabs `grabSize` (= `holesPerSide`) random seeds from the centre pool and drops
 * them one at a time into **their own** holes, choosing both the seed and the hole,
 * one seed per hole per turn. Each drop is swept immediately: seed category matches
 * the hole's type → a point for the dropper, otherwise a point for the opponent.
 * When the hand empties, the turn passes; when the pool is empty too, the game ends
 * and the larger storehouse wins (ties are allowed).
 *
 * v6 sowed into forced consecutive holes wrapping the ring. That made the hole
 * types decorative — there was never a decision to make — so v7 lets the player
 * choose, which is the whole point of a board painted with monocot and dicot icons.
 *
 * Determinism: seeded PRNG, so a given seed always produces the same board and
 * draws. The stream is not byte-compatible with C#'s `System.Random` — it does not
 * need to be, because the server is authoritative and the client renders what it
 * is told rather than re-simulating.
 */

// Declared in DakonConfig (the pinned hole layout is typed with it) and re-exported
// here, which is where the rest of the server has always imported it from.
export type { SeedCategory };

export type DakonPhase = "waiting" | "in_progress" | "finished";

export type DakonErrorCode =
  | "not_your_turn"
  | "invalid_hole"
  | "hole_already_sown"
  | "seed_not_in_hand";

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
  /** Holes that already took a seed this turn. Cleared when the turn passes. */
  private sown: boolean[] = [];
  private pool: Seed[] = [];
  private hand: Seed[] = [];

  /** Scored seed counts, `[seat][category]`. */
  private readonly stores: Record<SeedCategory, number>[] = [
    { monocot: 0, dicot: 0 },
    { monocot: 0, dicot: 0 },
  ];

  private activeSeat = 0;
  private currentPhase: DakonPhase = "waiting";

  private monocotCursor = 0;
  private dicotCursor = 0;

  constructor(rngSeed: number, config: Partial<DakonConfig> = {}) {
    this.config = { ...DAKON_DEFAULTS, ...config };
    this.random = makeRng(rngSeed);
  }

  // --- setup ---------------------------------------------------------------

  start(): void {
    this.holes = this.holeLayout();
    this.sown = new Array(this.holes.length).fill(false);
    this.fillPool();

    this.activeSeat = 0;
    this.currentPhase = "in_progress";
    this.grabHand();
  }

  /**
   * The hole types, copied from `config.holeTypes` rather than rolled.
   *
   * They used to be shuffled per side here, which made the twenty botanical icons
   * painted on the client's board decorative — a hole under a taproot was dicot only
   * half the time. The paint cannot move, so the ruleset is pinned to it instead; see
   * `DAKON_HOLE_TYPES`. Copied rather than aliased, so a board cannot write back
   * through the shared config into the next match.
   */
  private holeLayout(): SeedCategory[] {
    const total = totalHoles(this.config);
    const pinned = this.config.holeTypes;

    const layout: SeedCategory[] = new Array(total);
    for (let i = 0; i < total; i++) {
      layout[i] = pinned[i] ?? "monocot";
    }

    return layout;
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

  /** Which seat a ring index belongs to: 0 for the first `holesPerSide`, 1 for the rest. */
  sideOf(holeIndex: number): number {
    return holeIndex < this.config.holesPerSide ? 0 : 1;
  }

  // --- play ----------------------------------------------------------------

  /**
   * Drop one held seed into one of the active seat's own, still-empty holes. Every
   * rejection is a rule, not an exception: the caller turns the returned error code
   * into an `error` message.
   */
  drop(seat: number, seedId: string, holeIndex: number): DropResult {
    if (this.currentPhase !== "in_progress") return fail("invalid_hole");
    if (seat !== this.activeSeat) return fail("not_your_turn");
    if (!Number.isInteger(holeIndex) || holeIndex < 0 || holeIndex >= this.holes.length) {
      return fail("invalid_hole");
    }
    if (this.sideOf(holeIndex) !== this.activeSeat) return fail("invalid_hole");
    if (this.sown[holeIndex]) return fail("hole_already_sown");

    const handIndex = this.hand.findIndex((s) => s.id === seedId);
    if (handIndex < 0) return fail("seed_not_in_hand");

    const seed = this.hand[handIndex];
    const wasMatch = seed.category === this.holes[holeIndex];
    const scoringPlayer = wasMatch ? this.activeSeat : 1 - this.activeSeat;

    this.stores[scoringPlayer][seed.category]++;
    this.hand.splice(handIndex, 1);
    this.sown[holeIndex] = true;

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
      this.sown.fill(false);

      if (this.pool.length === 0) {
        this.currentPhase = "finished";
        result.gameOver = true;
      } else {
        this.activeSeat = 1 - this.activeSeat;
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

  /** True once a seed landed in this hole during the current turn. */
  isSown(holeIndex: number): boolean {
    return this.sown[holeIndex] === true;
  }

  /**
   * The sown holes as a bitmask, bit i = hole i — the shape the state syncs, so the
   * client reads the same thing it would compute. Twenty holes fit in 32 bits.
   */
  get sownMask(): number {
    let mask = 0;
    for (let i = 0; i < this.sown.length && i < 32; i++) {
      if (this.sown[i]) mask |= 1 << i;
    }
    return mask >>> 0;
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
