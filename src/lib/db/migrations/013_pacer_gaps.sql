-- PACER gaps. None of these tables feed the evidence reducer.

-- A familiar connection the learner supplies for a skill ("this reminds me of ..."). Learner data, never inferred.
-- It is part of the classification context, so changing it makes earlier approach decisions stale.
CREATE TABLE pacer_learner_connections (
  skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  connection_text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Formative tutor feedback on a learning response, requested by the learner. Not a grade: it never creates an
-- attempt or assessment. Requesting it records a feedback exposure for the skill in that session first.
ALTER TABLE pacer_responses ADD COLUMN feedback_text TEXT;
ALTER TABLE pacer_responses ADD COLUMN feedback_model TEXT;

-- AI-drafted activity material (and, when the unit has none, a teaching explanation) for imported skills, awaiting
-- owner review. Approval copies the material into pacer_contexts and the explanation into the unit.
CREATE TABLE pacer_material_drafts (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'invalid')),
  draft_json TEXT NOT NULL,
  problems_json TEXT NOT NULL DEFAULT '[]',
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('mock', 'live')),
  provider_model TEXT,
  prompt_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX pacer_material_drafts_skill ON pacer_material_drafts (skill_id, created_at);

-- Jobs gain the draft_material kind. SQLite cannot alter a CHECK constraint, so the table is rebuilt; rows are kept.
CREATE TABLE jobs_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('assess_attempt', 'draft_questions', 'draft_material')),
  ref_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  runs INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO jobs_new (id, kind, ref_id, status, runs, lease_until, error, created_at, updated_at)
  SELECT id, kind, ref_id, status, runs, lease_until, error, created_at, updated_at FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX jobs_claim ON jobs (status, created_at);
CREATE INDEX jobs_ref ON jobs (kind, ref_id, created_at);
