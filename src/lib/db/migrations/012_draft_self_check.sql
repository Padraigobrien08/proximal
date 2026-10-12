-- The drafting job grades each draft's own example answers with the live assessor before storing it. A draft whose
-- marking scheme mis-grades its examples cannot be approved for independent checks.
-- JSON: { status: "passed" | "failed" | "error" | "skipped", results: [{ label, expected, got }], message }.
ALTER TABLE question_drafts ADD COLUMN self_check_json TEXT;
