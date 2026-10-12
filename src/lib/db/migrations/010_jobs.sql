-- Background jobs run by the in-process worker (src/lib/jobs). A job is claimed with a lease, so a crash or restart
-- leaves it reclaimable rather than lost. Jobs hold ids only: the work itself (attempt, skill) lives in its own table.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('assess_attempt', 'draft_questions')),
  -- attempt id for assess_attempt; skill id for draft_questions.
  ref_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  -- Runs so far, counting runs cut short by a crash (expired lease).
  runs INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  -- Safe, user-facing failure message (never prompts, answers or keys).
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_claim ON jobs (status, created_at);
CREATE INDEX jobs_ref ON jobs (kind, ref_id, created_at);
