-- A study run is one press of Continue: a snapshot of the study plan, worked through as ordinary sessions in order.
CREATE TABLE study_runs (
  id TEXT PRIMARY KEY,
  scope_course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  scope_topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE,
  budget_minutes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended')),
  current_position INTEGER NOT NULL DEFAULT 0,
  -- Subtopic (unit) levels when the run started, to report what changed.
  start_levels_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE study_run_steps (
  run_id TEXT NOT NULL REFERENCES study_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  -- Frozen StudyTask from the plan.
  task_json TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  -- started (in progress) | done | left (moved on before finishing) | skipped (no session could start) | null (not reached)
  outcome TEXT CHECK (outcome IN ('started', 'done', 'left', 'skipped')),
  PRIMARY KEY (run_id, position)
);
CREATE INDEX study_run_steps_session ON study_run_steps(session_id);
