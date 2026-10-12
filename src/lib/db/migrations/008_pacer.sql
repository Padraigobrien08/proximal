-- PACER classification and learning activities. None of these tables feed the evidence reducer: evidence still comes
-- only from attempts, assessments and exposures.

-- Approved authored classification context per skill (goal, memory requirement, auxiliary chunks, activity material).
CREATE TABLE pacer_contexts (
  skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  context_version INTEGER NOT NULL,
  learning_goal TEXT,
  memory_requirement TEXT NOT NULL DEFAULT 'unspecified' CHECK (memory_requirement IN ('unspecified', 'recall_required', 'lookup_allowed')),
  -- [{ chunkId, kind, label, text }] authored auxiliary contexts (analogy, illustration, notation).
  aux_chunks_json TEXT NOT NULL DEFAULT '[]',
  -- Authored activity material (prompts, excerpts). Not classification input.
  material_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- Model (or offline fixture) proposals. Append-only; a new proposal never overwrites a decision.
CREATE TABLE pacer_proposals (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_version INTEGER NOT NULL,
  context_hash TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  routing_version TEXT NOT NULL,
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('mock', 'live')),
  -- vendor:model for live; null for the offline fixture.
  provider_model TEXT,
  -- suggestion | abstain: valid proposals. invalid: failed schema/grounding. error: provider failure (retry).
  kind TEXT NOT NULL CHECK (kind IN ('suggestion', 'abstain', 'invalid', 'error')),
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pacer_proposals_skill ON pacer_proposals(skill_id, created_at);
CREATE INDEX pacer_proposals_cache ON pacer_proposals(cache_key);

-- Learner review decisions. Proposed and chosen labels are stored separately; history is kept.
CREATE TABLE pacer_decisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT REFERENCES pacer_proposals(id) ON DELETE SET NULL,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_version INTEGER NOT NULL,
  context_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'edited', 'dismissed')),
  -- suggestion: from a reviewed proposal. manual: chosen by the learner without (or instead of) a proposal.
  origin TEXT NOT NULL CHECK (origin IN ('suggestion', 'manual')),
  primary_type TEXT,
  secondary_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  is_effective INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX pacer_decisions_effective ON pacer_decisions(skill_id) WHERE is_effective = 1;

-- Activities frozen into a learning session at start. A later decision affects new sessions only.
CREATE TABLE pacer_activities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_version INTEGER NOT NULL,
  decision_id TEXT REFERENCES pacer_decisions(id) ON DELETE SET NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
  frozen_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  -- open (step_index is the step to answer) | teach (teaching before the next step) | completed | skipped | unavailable
  status TEXT NOT NULL CHECK (status IN ('open', 'teach', 'completed', 'skipped', 'unavailable')),
  step_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX pacer_activities_session ON pacer_activities(session_id);

-- Learning responses: saved once per submission key. Workflow status only; never a pass or a grade.
CREATE TABLE pacer_responses (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES pacer_activities(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  submission_key TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  response_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted')),
  tutor_feedback TEXT,
  submitted_at INTEGER NOT NULL,
  UNIQUE (session_id, submission_key),
  UNIQUE (activity_id, step_index)
);
