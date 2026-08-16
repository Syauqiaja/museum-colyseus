/**
 * Minimal forward-only migration runner: applies every .sql file in
 * db/migrations in filename order, once, recording what it applied in
 * `schema_migrations`.
 *
 * Deliberately not an ORM or a migration framework — the schema is four tables
 * that change rarely, and a museum VPS should be able to run `npm run db:migrate`
 * with nothing installed beyond what the server already needs.
 *
 * Usage: npm run db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

async function main() {
  const database = process.env.DB_NAME ?? "museum_minigames";

  // Connect without a database first so a fresh machine can be set up in one command.
  const server = await mysql.createConnection({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    multipleStatements: true,
  });

  await server.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await server.changeUser({ database });

  await server.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(128) NOT NULL,
      applied_at DATETIME     NOT NULL,
      PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [rows] = await server.query<any[]>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await server.query(sql);
    await server.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, NOW())", [file]);

    console.log(`[migrate] applied ${file}`);
    count++;
  }

  console.log(
    count === 0
      ? `[migrate] ${database} already up to date (${files.length} migrations)`
      : `[migrate] ${database}: ${count} applied`,
  );

  await server.end();
}

main().catch((err) => {
  console.error("[migrate] failed:", err.message);
  process.exit(1);
});
