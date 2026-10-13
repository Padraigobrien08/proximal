-- 013 added pacer_responses.feedback_text, but 008 already has tutor_feedback for the same purpose. Feedback text is
-- stored in tutor_feedback (with the model in feedback_model); the unused duplicate is dropped.
ALTER TABLE pacer_responses DROP COLUMN feedback_text;
