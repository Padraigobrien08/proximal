// Export a course's curriculum, questions and learner records as JSON. Excludes secrets/env.
// Usage: npm run data:export -- --course <id> [--out file.json] [--include-reference-answers]
import { writeFileSync } from "node:fs";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { arg, dataDir, flag, loadDotEnv } from "./_lib";

loadDotEnv();
const courseId = arg("course");
if (!courseId) {
  console.error("Usage: npm run data:export -- --course <id> [--out file.json] [--include-reference-answers]");
  process.exit(1);
}
const includeRef = flag("include-reference-answers");
const db = openDatabase(databasePath(dataDir()));
runMigrations(db);
const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(courseId);
if (!course) {
  console.error(`No course ${courseId}.`);
  process.exit(1);
}
const all = (sql: string) => db.prepare(sql).all(courseId);
const topics = all("SELECT * FROM topics WHERE course_id = ?");
const units = all("SELECT u.* FROM units u JOIN topics t ON t.id = u.topic_id WHERE t.course_id = ?");
const skills = all("SELECT s.* FROM skills s JOIN units u ON u.id = s.unit_id JOIN topics t ON t.id = u.topic_id WHERE t.course_id = ?");
const questions = (all(
  "SELECT q.* FROM questions q JOIN skills s ON s.id = q.skill_id JOIN units u ON u.id = s.unit_id JOIN topics t ON t.id = u.topic_id WHERE t.course_id = ?",
) as Record<string, unknown>[]).map((q) => (includeRef ? q : { ...q, reference_json: "[omitted: pass --include-reference-answers]", examples_json: "[omitted]" }));
const sessionsSql = "SELECT s.* FROM sessions s JOIN topics t ON t.id = s.topic_id WHERE t.course_id = ?";
const sessions = all(sessionsSql);
const sessionQuestions = (all(`SELECT sq.* FROM session_questions sq WHERE sq.session_id IN (SELECT s.id FROM sessions s JOIN topics t ON t.id = s.topic_id WHERE t.course_id = ?)`) as Record<string, unknown>[]).map((sq) =>
  includeRef ? sq : { ...sq, frozen_question_json: "[omitted: contains reference answer]" },
);
const attempts = all("SELECT a.* FROM attempts a WHERE a.session_id IN (SELECT s.id FROM sessions s JOIN topics t ON t.id = s.topic_id WHERE t.course_id = ?)");
const exposures = all("SELECT e.* FROM exposures e WHERE e.session_id IN (SELECT s.id FROM sessions s JOIN topics t ON t.id = s.topic_id WHERE t.course_id = ?)");
const assessments = all(
  "SELECT asm.* FROM assessments asm JOIN attempts a ON a.id = asm.attempt_id WHERE a.session_id IN (SELECT s.id FROM sessions s JOIN topics t ON t.id = s.topic_id WHERE t.course_id = ?)",
);
const reviewStates = all("SELECT r.* FROM review_states r JOIN skills s ON s.id = r.skill_id JOIN units u ON u.id = s.unit_id JOIN topics t ON t.id = u.topic_id WHERE t.course_id = ?");
const sources = (all("SELECT id, course_id, sha256, original_name, label, page_count, status, error, created_at FROM sources WHERE course_id = ?"));

const out = arg("out") ?? `proximal-export-${courseId}.json`;
writeFileSync(
  out,
  JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      note: `Local export. No environment variables or API keys are included. Reference answers ${includeRef ? "ARE included" : "are omitted"}.`,
      course, topics, units, skills, questions, sources, sessions, sessionQuestions, attempts, exposures, assessments, reviewStates,
    },
    null,
    2,
  ),
);
console.log(`Wrote ${out} (reference answers ${includeRef ? "included" : "omitted"}).`);
db.close();
