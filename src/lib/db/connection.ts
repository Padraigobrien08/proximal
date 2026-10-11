import "server-only";
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readEnvSafe } from "../env-safe";
import { pendingMigrations } from "./backup";
import { MIGRATIONS_DIR, runMigrations } from "./migrate";

export type DB = Database.Database;

/** Open a connection with the required pragmas. Foreign keys are enabled on every connection. */
export function openDatabase(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  return db;
}

export function databasePath(dataDir: string): string {
  return path.join(dataDir, "proximal.db");
}

const globalForDb = globalThis as unknown as { __proximalDb?: { file: string; db: DB } };

/** Process-wide connection for the Next.js server (survives dev hot reloads). */
export function getDb(): DB {
  const file = databasePath(readEnvSafe().dataDir);
  const cached = globalForDb.__proximalDb;
  if (cached && cached.file === file) return cached.db;
  const db = openDatabase(file);
  // Schema changes to an existing database are preceded by a synchronous safety copy.
  const pending = pendingMigrations(db, MIGRATIONS_DIR);
  const hasData = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'courses'").get();
  if (pending.length > 0 && hasData) backupBeforeMigrate(db, file);
  runMigrations(db);
  globalForDb.__proximalDb = { file, db };
  return db;
}

/** Synchronous pre-migration safety copy: checkpoint the WAL, then copy the database file. */
function backupBeforeMigrate(db: DB, file: string) {
  db.pragma("wal_checkpoint(TRUNCATE)");
  const dir = path.join(path.dirname(file), "backups", `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}-pre-migrate`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, path.join(dir, "proximal.db"));
}
