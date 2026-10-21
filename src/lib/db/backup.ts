import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** Backups beyond the newest `BACKUP_KEEP`, or older than `BACKUP_MAX_AGE_DAYS`, are deleted; the newest is always kept. */
export const BACKUP_KEEP = 10;
export const BACKUP_MAX_AGE_DAYS = 30;
const MS_DAY = 24 * 60 * 60 * 1000;

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
 * a copy of uploaded PDFs, into `<dataDir>/backups/<stamp>[-label]/`, then applies the retention rule (pruneBackups).
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

  const pruned = pruneBackups(root, { keep: opts.keep });
  return { dir, database, uploadsCopied, pruned };
}

/** When a backup folder was taken: from its `YYYYMMDD-HHMMSS` (UTC) name, else the folder's modification time. */
export function backupTakenAt(root: string, name: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return statSync(path.join(root, name)).mtimeMs;
}

/** Backup folders, oldest first. */
export function listBackups(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => statSync(path.join(root, d)).isDirectory())
    .sort((a, b) => backupTakenAt(root, a) - backupTakenAt(root, b) || a.localeCompare(b));
}

/**
 * Retention: delete backups beyond the newest `keep` and any older than `maxAgeDays`, but never the newest one, so a
 * data directory is never left without a backup. Returns the deleted folder names.
 */
export function pruneBackups(root: string, opts: { keep?: number; maxAgeDays?: number; now?: number } = {}): string[] {
  const keep = opts.keep ?? BACKUP_KEEP;
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeDays ?? BACKUP_MAX_AGE_DAYS) * MS_DAY;
  const all = listBackups(root);
  const pruned = all.filter((d, i) => i < all.length - 1 && (i < all.length - keep || backupTakenAt(root, d) < cutoff));
  for (const d of pruned) rmSync(path.join(root, d), { recursive: true, force: true });
  return pruned;
}

/** Backup folders whose database still holds this course (for a deletion warning). Unreadable copies are skipped. */
export function backupsContainingCourse(dataDir: string, courseId: string): { name: string; takenAt: number }[] {
  const root = path.join(dataDir, "backups");
  return listBackups(root).flatMap((name) => {
    const file = path.join(root, name, "proximal.db");
    if (!existsSync(file)) return [];
    let copy: Database.Database | null = null;
    try {
      copy = new Database(file, { readonly: true, fileMustExist: true });
      return copy.prepare("SELECT 1 FROM courses WHERE id = ?").get(courseId) ? [{ name, takenAt: backupTakenAt(root, name) }] : [];
    } catch {
      return [];
    } finally {
      copy?.close();
    }
  });
}

/** Pending migration file names (without applying them). */
export function pendingMigrations(db: Database.Database, dir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set((db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();
}
