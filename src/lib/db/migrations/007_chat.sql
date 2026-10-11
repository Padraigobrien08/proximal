-- "Ask your lectures": one or more conversations per module, answered from the module's lecture pages.
CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chat_threads_course ON chat_threads(course_id, updated_at);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  -- Assistant only: [{ sourceId, sourceLabel, page }] the answer relies on.
  citations_json TEXT NOT NULL DEFAULT '[]',
  -- Assistant only: 1 when answered from the lecture pages, 0 for a labelled general answer.
  covered INTEGER NOT NULL DEFAULT 1,
  -- live: model answer; offline: retrieval only (no AI); error: the model call failed.
  origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'offline', 'error')),
  created_at INTEGER NOT NULL
);
CREATE INDEX chat_messages_thread ON chat_messages(thread_id, created_at);

-- Skills whose subtopic pages were retrieved for an answer: chat about them counts as help for a while.
CREATE TABLE chat_skill_touches (
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  touched_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, skill_id)
);
CREATE INDEX chat_skill_touches_skill ON chat_skill_touches(skill_id, touched_at);
