import { withDb } from "./pool.js";

/**
 * The `live_sessions` table: who is sitting in which room right now.
 *
 * This is an observability/ops view — a kiosk dashboard, "is anyone playing", and
 * a way to see a stuck room — not a source of truth. The rooms themselves own live
 * state; every row here describes a socket, and no socket survives a restart, which
 * is why {@link clearLiveSessions} wipes the table on boot.
 */

export interface LiveSeat {
  sessionId: string;
  roomId: string;
  game: string;
  playerId: string | null;
  displayName: string;
  seat: number;
}

/** Boot-time sweep: rows from a previous process describe sockets that are gone. */
export async function clearLiveSessions(): Promise<void> {
  await withDb("clear stale live sessions", (db) => db.execute("DELETE FROM live_sessions"));
}

export async function seatJoined(seat: LiveSeat): Promise<void> {
  await withDb("record seat joined", (db) =>
    db.execute(
      `INSERT INTO live_sessions
         (session_id, room_id, game, player_id, display_name, seat, connected, joined_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         room_id = VALUES(room_id), game = VALUES(game), player_id = VALUES(player_id),
         display_name = VALUES(display_name), seat = VALUES(seat),
         connected = TRUE, updated_at = NOW()`,
      [seat.sessionId, seat.roomId, seat.game, seat.playerId, seat.displayName, seat.seat],
    ),
  );
}

/** Dropped inside the reconnection window — the seat is held, not freed. */
export async function seatConnectionChanged(sessionId: string, connected: boolean): Promise<void> {
  await withDb("update seat connectivity", (db) =>
    db.execute(`UPDATE live_sessions SET connected = ?, updated_at = NOW() WHERE session_id = ?`, [
      connected,
      sessionId,
    ]),
  );
}

export async function seatLeft(sessionId: string): Promise<void> {
  await withDb("record seat left", (db) =>
    db.execute("DELETE FROM live_sessions WHERE session_id = ?", [sessionId]),
  );
}

/** Whole room gone (disposed): drop any seats still attributed to it. */
export async function roomClosed(roomId: string): Promise<void> {
  await withDb("clear room seats", (db) =>
    db.execute("DELETE FROM live_sessions WHERE room_id = ?", [roomId]),
  );
}
