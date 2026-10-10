// Delete a course with all dependent records and its uploaded PDFs.
// Usage: npm run data:delete-course -- --course <id> --confirm <id>
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { arg, dataDir, loadDotEnv } from "./_lib";

loadDotEnv();
const courseId = arg("course");
if (!courseId || arg("confirm") !== courseId) {
  console.error("Usage: npm run data:delete-course -- --course <id> --confirm <id>   (the id must be typed twice)");
  process.exit(1);
}
const dir = dataDir();
const db = openDatabase(databasePath(dir));
runMigrations(db);
const course = db.prepare("SELECT id, title, is_demo FROM courses WHERE id = ?").get(courseId) as { id: string; title: string; is_demo: number } | undefined;
if (!course) {
  console.error(`No course ${courseId}.`);
  process.exit(1);
}
const files = (db.prepare("SELECT stored_path FROM sources WHERE course_id = ?").all(courseId) as { stored_path: string }[]).map((r) =>
  path.join(dir, "uploads", path.basename(r.stored_path)),
);
db.transaction(() => {
  // session_questions reference questions without cascade; remove learner records first.
  db.prepare("DELETE FROM sessions WHERE topic_id IN (SELECT id FROM topics WHERE course_id = ?)").run(courseId);
  db.prepare("DELETE FROM review_states WHERE skill_id IN (SELECT s.id FROM skills s JOIN units u ON u.id = s.unit_id JOIN topics t ON t.id = u.topic_id WHERE t.course_id = ?)").run(courseId);
  db.prepare("DELETE FROM courses WHERE id = ?").run(courseId);
})();
for (const f of files) if (existsSync(f)) rmSync(f);
console.log(`Deleted course "${course.title}" (${courseId}) with its sessions, attempts, exposures, assessments and ${files.length} file(s).${course.is_demo ? " Run npm run db:seed to recreate the demo." : ""}`);
db.close();
