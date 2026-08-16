import type { ResultSetHeader } from "mysql2";
import { withDb } from "./pool.js";
import { recordMatchOutcome } from "./players.js";

/**
 * The `matches` / `match_players` tables: what happened in a room, once.
 *
 * A row is opened when a match starts and closed when it ends, so a match that is
 * still running (or that died with the process) is visible as `in_progress` rather
 * than silently missing. Scores are always the server's — these rows are written
 * from authoritative state, never from anything a client reported.
 */

export type MatchOutcome = "completed" | "forfeited" | "abandoned";

/** One seat's result, as the room's own state knows it. */
export interface MatchPlayerResult {
  seat: number;
  sessionId: string;
  playerId: string | null;
  displayName: string;
  score: number;
}

/**
 * Open a match row at start. Returns the id used to close it later, or undefined
 * when persistence is off/unavailable — callers must treat that as normal.
 */
export async function startMatch(
  roomId: string,
  game: string,
  players: readonly MatchPlayerResult[],
): Promise<number | undefined> {
  const matchId = await withDb("open match", async (db) => {
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO matches (room_id, game, started_at, outcome) VALUES (?, ?, NOW(), 'in_progress')`,
      [roomId, game],
    );
    return result.insertId;
  });

  if (matchId === undefined) return undefined;

  await writeSeats(matchId, players, null);
  return matchId;
}

/**
 * Close a match: final scores, outcome, winner. `winnerSessionId` is null for a
 * tie or an unfinished match. Also folds the result into the player profiles.
 */
export async function finishMatch(
  matchId: number | undefined,
  outcome: MatchOutcome,
  players: readonly MatchPlayerResult[],
  winnerSessionId: string | null,
): Promise<void> {
  if (matchId === undefined) return;

  const winner = players.find((p) => p.sessionId === winnerSessionId) ?? null;

  await withDb("close match", (db) =>
    db.execute(
      `UPDATE matches SET ended_at = NOW(), outcome = ?, winner_player_id = ? WHERE match_id = ?`,
      [outcome, winner?.playerId ?? null, matchId],
    ),
  );

  await writeSeats(matchId, players, winnerSessionId);
  await recordMatchOutcome(
    players.map((p) => p.playerId),
    winner?.playerId ?? null,
  );
}

/**
 * Upsert the seat rows. Written twice per match (open + close) so a match that
 * never finishes still says who was in it.
 */
async function writeSeats(
  matchId: number,
  players: readonly MatchPlayerResult[],
  winnerSessionId: string | null,
): Promise<void> {
  if (players.length === 0) return;

  const values = players.map((p) => [
    matchId,
    p.seat,
    p.playerId,
    p.sessionId,
    p.displayName,
    p.score,
    p.sessionId === winnerSessionId,
  ]);

  await withDb("write match seats", (db) =>
    db.query(
      `INSERT INTO match_players
         (match_id, seat, player_id, session_id, display_name, score, is_winner)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         player_id = VALUES(player_id),
         session_id = VALUES(session_id),
         display_name = VALUES(display_name),
         score = VALUES(score),
         is_winner = VALUES(is_winner)`,
      [values],
    ),
  );
}
