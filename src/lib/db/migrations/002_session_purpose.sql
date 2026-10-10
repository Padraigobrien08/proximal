-- What the learner chose to do; decides labels (Learn, Supported practice, Independent check, Review).
ALTER TABLE sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'learn' CHECK (purpose IN ('learn', 'practice', 'check', 'review'));
UPDATE sessions SET purpose = 'check' WHERE mode = 'review';
