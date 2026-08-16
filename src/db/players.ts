import { withDb } from "./pool.js";

/**
 * The `players` table: one row per stable client GUID.
 *
 * The GUID is minted by the Unity client and stored in PlayerPrefs, so it survives
 * a tab refresh and identifies the same visitor across visits. It is **not** a
 * credential and is not trusted for anything that matters — a client can forge or
 * clear it. It only decides which stats row gets incremented, never who may act in
 * a room (that is always the Colyseus sessionId).
 */

/** Shape a client-supplied playerId must have before it touches the database. */
const GUID = /^[0-9a-fA-F-]{36}$/;

/**
 * Accept a client-sent playerId, or return null when it is missing/malformed.
 * A null id costs the player their profile row, not their seat.
 */
export function sanitizePlayerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return GUID.test(trimmed) ? trimmed : null;
}

/** Create the profile if new, otherwise refresh nickname + last-seen. */
export async function touchPlayer(playerId: string | null, displayName: string): Promise<void> {
  if (!playerId) return;

  await withDb("touch player", (db) =>
    db.execute(
      `INSERT INTO players (player_id, display_name, first_seen_at, last_seen_at)
       VALUES (?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), last_seen_at = NOW()`,
      [playerId, displayName],
    ),
  );
}

/**
 * Count a finished match against the profiles that took part. Called once per
 * match, after the result rows are written.
 */
export async function recordMatchOutcome(
  playerIds: readonly (string | null)[],
  winnerPlayerId: string | null,
): Promise<void> {
  const ids = playerIds.filter((id): id is string => id !== null);
  if (ids.length === 0) return;

  await withDb("record player totals", (db) =>
    db.execute(
      `UPDATE players
          SET games_played = games_played + 1,
              wins = wins + IF(player_id = ?, 1, 0)
        WHERE player_id IN (${ids.map(() => "?").join(", ")})`,
      [winnerPlayerId, ...ids],
    ),
  );
}
