import mysql from "mysql2/promise";
import type { Pool, PoolOptions } from "mysql2/promise";

/**
 * The one MySQL connection pool. Everything that persists goes through here.
 *
 * Persistence is **secondary to gameplay**: a museum kiosk must keep playing when
 * the database is unreachable. So nothing in this module throws at import time, the
 * pool is created lazily, and callers use {@link withDb}, which swallows and logs
 * failures instead of propagating them into a Room's lifecycle hook. Losing a
 * results row is acceptable; dropping a live match because MySQL restarted is not.
 */

let pool: Pool | undefined;
let disabled = false;

/** Warn once per process rather than on every failed write. */
let warnedUnavailable = false;

function config(): PoolOptions {
  return {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    database: process.env.DB_NAME ?? "museum_minigames",
    connectionLimit: Number(process.env.DB_POOL_SIZE ?? 10),
    charset: "utf8mb4_unicode_ci",

    // A kiosk on flaky venue wifi should fail fast and keep playing, not hang a
    // room's onLeave waiting for a socket.
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
    waitForConnections: true,
    queueLimit: 0,
  };
}

/**
 * Turn persistence off for this process. Used by tests that don't care about
 * rows, and available as `DB_DISABLED=1` for a venue running without a database.
 */
export function disableDb() {
  disabled = true;
}

export function isDbDisabled(): boolean {
  return disabled || process.env.DB_DISABLED === "1";
}

export function getPool(): Pool | undefined {
  if (isDbDisabled()) return undefined;
  if (!pool) pool = mysql.createPool(config());
  return pool;
}

/**
 * Run a database operation, returning `undefined` if persistence is off or the
 * operation fails. Callers treat the result as best-effort — never as a
 * precondition for a game continuing.
 *
 * @param label short description used in the warning when it fails ("record match")
 */
export async function withDb<T>(
  label: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T | undefined> {
  const db = getPool();
  if (!db) return undefined;

  try {
    return await fn(db);
  } catch (err) {
    // Seat rows are deleted by two paths at once when a room closes (each player's
    // own row, plus the room-wide sweep), which InnoDB can resolve as a deadlock.
    // Every write here is idempotent, so one retry is safe and usually enough.
    if ((err as { code?: string }).code === "ER_LOCK_DEADLOCK") {
      try {
        return await fn(db);
      } catch {
        // fall through to the warning below
      }
    }

    if (!warnedUnavailable) {
      console.warn(
        `[db] persistence unavailable — gameplay continues without it. First failure: ${label}`,
      );
      warnedUnavailable = true;
    }
    console.warn(`[db] ${label} failed:`, (err as Error).message);
    return undefined;
  }
}

/** Close the pool (tests, graceful shutdown). Safe to call when never opened. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = undefined;
  await closing.end();
}
