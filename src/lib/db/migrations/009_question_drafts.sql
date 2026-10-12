-- AI-drafted assessment questions awaiting owner review. Drafts never feed question selection or evidence: only an
-- approved draft becomes a row in `questions` (status owner_reviewed), and that row is what checks use.
CREATE TABLE question_drafts (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_version INTEGER NOT NULL,
  -- One generation request; its drafts share a batch id.
  batch_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- draft: awaiting review. approved: copied into `questions`. rejected: dismissed by the owner.
  -- invalid: failed server-side checks (kept so the failure is visible; cannot be approved until edited).
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'rejected', 'invalid')),
  -- The DraftQuestion shape (src/lib/questions/drafts.ts), as generated or as last edited by the owner.
  question_json TEXT NOT NULL,
  problems_json TEXT NOT NULL DEFAULT '[]',
  edited INTEGER NOT NULL DEFAULT 0,
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('mock', 'live')),
  -- vendor:model for live; null for the offline fixture.
  provider_model TEXT,
  prompt_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  question_id TEXT REFERENCES questions(id) ON DELETE SET NULL
);
CREATE INDEX question_drafts_skill ON question_drafts (skill_id, created_at);

-- Set when the owner opened the draft's answer key. Such a draft can only become a practice question.
ALTER TABLE question_drafts ADD COLUMN answer_seen INTEGER NOT NULL DEFAULT 0;

-- A practice-only question is never selected for an independent check (its answer key was seen during review).
ALTER TABLE questions ADD COLUMN practice_only INTEGER NOT NULL DEFAULT 0;
