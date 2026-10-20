// Export a course's curriculum, questions and learner records as JSON. Excludes secrets/env and unreviewed drafts.
// Usage: npm run data:export -- --course <id> [--out file.json] [--include-reference-answers]
import { writeFileSync } from "node:fs";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { exportCourseData } from "../src/lib/services/courseData";
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
if (!db.prepare("SELECT 1 FROM courses WHERE id = ?").get(courseId)) {
  console.error(`No course ${courseId}.`);
  process.exit(1);
}
const data = exportCourseData(db, courseId, { includeReferenceAnswers: includeRef, now: Date.now() });
const out = arg("out") ?? `proximal-export-${courseId}.json`;
writeFileSync(out, JSON.stringify(data, null, 2));
console.log(`Wrote ${out} (reference answers ${includeRef ? "included" : "omitted"}).`);
db.close();
