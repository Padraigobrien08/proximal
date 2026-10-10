-- Proximal initial schema. Timestamps are UTC integer milliseconds.

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft', 'approved')),
  suggestions_json TEXT NOT NULL DEFAULT '[]',
  notice TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  original_name TEXT NOT NULL,
  label TEXT,
  stored_path TEXT NOT NULL,
  page_count INTEGER,
  status TEXT NOT NULL CHECK (status IN ('processing', 'extracted', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX sources_sha ON sources(sha256);

CREATE TABLE source_pages (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  extracted_text TEXT NOT NULL,
  low_text_warning INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, page_number)
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE units (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  approval_status TEXT NOT NULL CHECK (approval_status IN ('draft', 'approved', 'superseded')),
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  explanation TEXT,
  worked_example TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  supersedes_unit_id TEXT REFERENCES units(id)
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  transfer_required INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  family_id TEXT NOT NULL,
  is_transfer INTEGER NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('explain', 'calculate', 'derive', 'apply')),
  prompt TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  rubric_json TEXT NOT NULL,
  hints_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  reveal_skill_ids_json TEXT NOT NULL,
  examples_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('authored_fixture', 'owner_reviewed', 'excluded')),
  reviewed_by TEXT,
  reviewed_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('learn', 'review')),
  is_demo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  -- review: checkpoint -> results -> repair. learn: learning.
  phase TEXT NOT NULL CHECK (phase IN ('checkpoint', 'results', 'repair', 'learning')),
  current_ordinal INTEGER NOT NULL DEFAULT 0,
  feedback_released_at INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE session_questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id),
  skill_id TEXT NOT NULL REFERENCES skills(id),
  ordinal INTEGER NOT NULL,
  checkpoint_index INTEGER,
  phase TEXT NOT NULL CHECK (phase IN ('checkpoint', 'practice')),
  -- Frozen private question/rubric snapshot for this session.
  frozen_question_json TEXT NOT NULL,
  repeated_family INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, ordinal)
);

-- Single server-side counter shared by attempts and exposures.
CREATE TABLE record_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO record_counter (id, value) VALUES (1, 0);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_question_id TEXT NOT NULL REFERENCES session_questions(id) ON DELETE CASCADE,
  submission_key TEXT NOT NULL,
  answer TEXT NOT NULL,
  dont_know INTEGER NOT NULL DEFAULT 0,
  declared_assistance INTEGER NOT NULL DEFAULT 0,
  confidence TEXT CHECK (confidence IN ('low', 'medium', 'high')),
  phase TEXT NOT NULL CHECK (phase IN ('original', 'repair')),
  -- Exposure snapshot frozen at submission (skill ids exposed before this attempt in this session).
  exposure_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'assessing', 'assessed', 'provider_error')),
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  feedback_withheld INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER NOT NULL,
  record_order INTEGER NOT NULL UNIQUE,
  UNIQUE (session_id, submission_key)
);
CREATE INDEX attempts_sq ON attempts(session_question_id);

CREATE TABLE exposures (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('explanation', 'feedback', 'hint', 'source', 'solution', 'external_assistance')),
  affected_skill_ids_json TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  record_order INTEGER NOT NULL UNIQUE
);
CREATE INDEX exposures_session ON exposures(session_id);

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('mock', 'live', 'rule')),
  provider_model TEXT,
  prompt_version TEXT,
  usage_json TEXT,
  rubric_version INTEGER NOT NULL,
  criteria_json TEXT NOT NULL,
  possible_misconception TEXT,
  problems_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'partial', 'fail', 'uncertain')),
  validity TEXT NOT NULL CHECK (validity IN ('valid', 'invalid')),
  excluded INTEGER NOT NULL DEFAULT 0,
  excluded_reason TEXT,
  excluded_at INTEGER,
  assessed_at INTEGER NOT NULL
);

CREATE TABLE review_states (
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  skill_version INTEGER NOT NULL,
  evidence_state TEXT NOT NULL CHECK (evidence_state IN ('unassessed', 'developing', 'supported', 'demonstrated_once', 'retention_demonstrated')),
  epoch INTEGER NOT NULL,
  stage INTEGER,
  due_at INTEGER,
  last_pass_at INTEGER,
  reassessment_needed INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (skill_id, skill_version)
);
