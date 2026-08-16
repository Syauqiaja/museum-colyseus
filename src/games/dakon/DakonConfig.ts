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

  /** Dicot holes per side; the rest of the side is monocot. Shuffled per side. */
  dicotPerSide: number;

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
export const DAKON_DEFAULTS: DakonConfig = {
  poolSeeds: 60,
  grabSize: 15,
  holesPerSide: 10,
  dicotPerSide: 5,
  monocotTypeIds: ["beras", "gabah", "alpukat", "zaitun"],
  dicotTypeIds: ["jagung", "kacang_tanah", "kakao", "mangga"],
};

export function totalHoles(config: DakonConfig): number {
  return config.holesPerSide * 2;
}
