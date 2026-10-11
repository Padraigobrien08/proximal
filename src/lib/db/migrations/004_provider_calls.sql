-- One row per live provider call (assess, curriculum, tutor). Never stores prompts, answers or keys.
CREATE TABLE provider_calls (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL CHECK (job IN ('assess', 'curriculum', 'tutor')),
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'blocked')),
  error_code TEXT,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  started_at INTEGER NOT NULL
);
CREATE INDEX provider_calls_started ON provider_calls(started_at);
