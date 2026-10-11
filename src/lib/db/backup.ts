import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

export interface BackupResult {
  dir: string;
  database: string;
  uploadsCopied: number;
  pruned: string[];
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

/**
 * Consistent online backup of the SQLite database (better-sqlite3 backup API, safe while the app is running) plus
 * a copy of uploaded PDFs, into `<dataDir>/backups/<stamp>[-label]/`. Keeps the newest `keep` backups.
 */
export async function backupData(db: Database.Database, dataDir: string, opts: { label?: string; keep?: number } = {}): Promise<BackupResult> {
  const root = path.join(dataDir, "backups");
  const name = `${stamp()}${opts.label ? `-${opts.label.replace(/[^a-z0-9-]/gi, "")}` : ""}`;
  let dir = path.join(root, name);
  for (let i = 2; existsSync(dir); i++) dir = path.join(root, `${name}-${i}`);
  mkdirSync(dir, { recursive: true });
  const database = path.join(dir, "proximal.db");
  await db.backup(database);

  let uploadsCopied = 0;
  const uploads = path.join(dataDir, "uploads");
  if (existsSync(uploads)) {
    const dest = path.join(dir, "uploads");
    mkdirSync(dest, { recursive: true });
    for (const f of readdirSync(uploads)) {
      const src = path.join(uploads, f);
      if (statSync(src).isFile()) {
        copyFileSync(src, path.join(dest, f));
        uploadsCopied += 1;
      }
    }
  }

  const keep = opts.keep ?? 10;
  const all = readdirSync(root)
    .filter((d) => statSync(path.join(root, d)).isDirectory())
    .sort();
  const pruned = all.slice(0, Math.max(0, all.length - keep));
  for (const d of pruned) rmSync(path.join(root, d), { recursive: true, force: true });
  return { dir, database, uploadsCopied, pruned };
}

/** Pending migration file names (without applying them). */
export function pendingMigrations(db: Database.Database, dir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set((db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();
}
