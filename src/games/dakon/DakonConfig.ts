/**
 * The two seed categories, and also a hole's type — a drop scores when the seed's
 * category equals the hole's. Declared here rather than in `DakonBoard` because the
 * pinned hole layout below needs it and the board imports this file, not the reverse.
 * `DakonBoard` re-exports it, so every existing import site is unaffected.
 */
export type SeedCategory = "monocot" | "dicot";

/**
 * Tunables for a Dakon game. Defaults are the settled **v6 ruleset** values, which
 * are the ones the Unity client implements and has been played against
 * (`Assets/Scripts/Games/Dakon/DakonConfig.cs`). Keep the two in step: the server
 * is authoritative, so a divergence shows up as a client that renders a board the
 * server does not have.
 *
 * This file is the source of that pairing. The client's copy exists only to run its
 * offline hotseat game and cannot be overridden per-scene, so these values decide
 * the shape of a match in both modes.
 */
export interface DakonConfig {
  /** Total seeds in the pool. 60 = 30 monocot + 30 dicot → 4 grabs of 15 = 2 turns each. */
  poolSeeds: number;

  /** Seeds grabbed per turn — takes min(grabSize, poolRemaining). */
  grabSize: number;

  /** Holes per player side. The ring is holesPerSide * 2. */
  holesPerSide: number;

  /**
   * Every hole's type, in ring order. Fixed, not rolled — see `DAKON_HOLE_TYPES`.
   * Length must be `holesPerSide * 2`.
   */
  holeTypes: SeedCategory[];

  /** Species ids handed out round-robin to monocot seeds. The client maps id → sprite. */
  monocotTypeIds: string[];

  /** Species ids handed out round-robin to dicot seeds. */
  dicotTypeIds: string[];
}

/**
 * Species ids are each Unity `SeedType` asset's `typeId` field (`Assets/Resources/Seeds/`,
 * not the asset filename), grouped by the category each asset itself declares — so a
 * seed the server calls monocot renders with a sprite the client also files under
 * monocot.
 *
 * Note for content review, not for code: some of those assets' categories look
 * botanically off (Jagung/corn is authored as the same category as Kacang Tanah).
 * The server does not second-guess them — it mirrors the client's own grouping.
 */
/**
 * The hole layout, pinned to the board's own artwork.
 *
 * The Unity client's board texture (`Assets/Texture2D/dakon_surface.png`) has a
 * botanical icon painted above each of the twenty holes — a corn kernel, a taproot,
 * a five-petal flower — and a player reads them to decide where a seed belongs. The
 * types used to be shuffled per side at `start()`, which made those icons decorative:
 * a hole under a taproot was dicot only half the time, and neither repo can move
 * paint. So the ruleset is pinned to the picture instead.
 *
 * Ring order follows the client's hole anchors, which follow the art. Indices 0–9 are
 * seat 0's row — the near one on screen, left to right. Indices 10–19 are seat 1's,
 * whose `p0` anchor is the *rightmost* hole, so that row reads right to left. Each
 * entry names the icon it was read from; change one only when the texture changes.
 *
 * This must stay identical to the client's `DakonConfig.HoleTypes`
 * (`Assets/Scripts/Games/Dakon/DakonConfig.cs`) or an online board disagrees with the
 * board the player is looking at.
 */
export const DAKON_HOLE_TYPES: SeedCategory[] = [
  // Seat 0 — near row, screen left to right.
  "monocot", //  0  one cotyledon (corn kernel)
  "dicot", //    1  pinnate and palmate leaves
  "dicot", //    2  two cotyledons
  "dicot", //    3  five-petal flower
  "monocot", //  4  fibrous roots
  "dicot", //    5  taproot
  "monocot", //  6  three-part flower
  "monocot", //  7  scattered vascular bundles
  "monocot", //  8  one cotyledon (corn kernel)
  "dicot", //    9  taproot

  // Seat 1 — far row. Its p0 is the rightmost hole, so this runs right to left.
  "dicot", //   10  pinnate and palmate leaves
  "monocot", // 11  parallel-veined leaf
  "dicot", //   12  five-petal flower
  "monocot", // 13  fibrous roots
  "dicot", //   14  ringed vascular bundles
  "monocot", // 15  parallel-veined leaf
  "monocot", // 16  three-part flower
  "monocot", // 17  scattered vascular bundles
  "dicot", //   18  two cotyledons
  "dicot", //   19  ringed vascular bundles
];

export const DAKON_DEFAULTS: DakonConfig = {
  poolSeeds: 60,
  grabSize: 15,
  holesPerSide: 10,
  holeTypes: DAKON_HOLE_TYPES,
  monocotTypeIds: ["beras", "gabah", "alpukat", "zaitun"],
  dicotTypeIds: ["jagung", "kacang_tanah", "kakao", "mangga"],
};

export function totalHoles(config: DakonConfig): number {
  return config.holesPerSide * 2;
}
