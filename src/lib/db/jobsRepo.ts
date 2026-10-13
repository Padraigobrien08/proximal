// Background job repository. One process, so claiming is a plain transaction; the lease is what makes a job survive
// a crash or restart. Parameterised SQL only.
import type Database from "better-sqlite3";
import { newId } from "./repo";

type DB = Database.Database;

export type JobKind = "assess_attempt" | "draft_questions" | "draft_material";
export type JobStatus = "queued" | "running" | "done" | "failed";

/** Longer than the job's worst case (provider timeout plus one repair turn), so a live run is never reclaimed. */
export const JOB_LEASE_MS: Record<JobKind, number> = { assess_attempt: 4 * 60_000, draft_questions: 8 * 60_000, draft_material: 8 * 60_000 };
/** Runs cut short by a crash before a job is given up. Provider errors are not crashes: handlers record them. */
export const MAX_JOB_RUNS = 3;

export interface JobRow {
  id: string;
  kind: JobKind;
  refId: string;
  status: JobStatus;
  runs: number;
  leaseUntil: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawJob {
  id: string;
  kind: JobKind;
  ref_id: string;
  status: JobStatus;
  runs: number;
  lease_until: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const mapJob = (r: RawJob): JobRow => ({
  id: r.id,
  kind: r.kind,
  refId: r.ref_id,
  status: r.status,
  runs: r.runs,
  leaseUntil: r.lease_until,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Queue a job unless one for the same work is already queued or running; returns the active job either way. */
export function enqueueJob(db: DB, kind: JobKind, refId: string, now: number): JobRow {
  return db.transaction(() => {
    const active = db
      .prepare("SELECT * FROM jobs WHERE kind = ? AND ref_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1")
      .get(kind, refId) as RawJob | undefined;
    if (active) return mapJob(active);
    const id = newId();
    db.prepare("INSERT INTO jobs (id, kind, ref_id, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)").run(id, kind, refId, now, now);
    return getJob(db, id)!;
  })();
}

export function getJob(db: DB, id: string): JobRow | null {
  const r = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as RawJob | undefined;
  return r ? mapJob(r) : null;
}

export function latestJob(db: DB, kind: JobKind, refId: string): JobRow | null {
  const r = db.prepare("SELECT * FROM jobs WHERE kind = ? AND ref_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(kind, refId) as
    | RawJob
    | undefined;
  return r ? mapJob(r) : null;
}

/**
 * Claim the oldest runnable job: queued, or running with an expired lease (its process died). A job already cut short
 * MAX_JOB_RUNS times is marked failed instead of being run again.
 */
export function claimNextJob(db: DB, now: number): JobRow | null {
  return db.transaction(() => {
    for (;;) {
      const r = db
        .prepare(
          `SELECT * FROM jobs WHERE status = 'queued' OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
           ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(now) as RawJob | undefined;
      if (!r) return null;
      if (r.runs >= MAX_JOB_RUNS) {
        db.prepare("UPDATE jobs SET status = 'failed', lease_until = NULL, error = ?, updated_at = ? WHERE id = ?").run(
          "Stopped after being interrupted repeatedly.",
          now,
          r.id,
        );
        continue;
      }
      db.prepare("UPDATE jobs SET status = 'running', runs = runs + 1, lease_until = ?, updated_at = ? WHERE id = ?").run(
        now + JOB_LEASE_MS[r.kind],
        now,
        r.id,
      );
      return getJob(db, r.id);
    }
  })();
}

/** Claim one specific queued job (inline runs). Null when it is already running or finished. */
export function claimJob(db: DB, id: string, now: number): JobRow | null {
  const r = db.prepare("SELECT kind FROM jobs WHERE id = ? AND status = 'queued'").get(id) as { kind: JobKind } | undefined;
  if (!r) return null;
  const res = db
    .prepare("UPDATE jobs SET status = 'running', runs = runs + 1, lease_until = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
    .run(now + JOB_LEASE_MS[r.kind], now, id);
  return res.changes === 1 ? getJob(db, id) : null;
}

export function finishJob(db: DB, id: string, status: "done" | "failed", error: string | null, now: number) {
  db.prepare("UPDATE jobs SET status = ?, lease_until = NULL, error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(status, error, now, id);
}

