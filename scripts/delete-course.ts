// Delete a course with all dependent records and its uploaded PDFs.
// Usage: npm run data:delete-course -- --course <id> --confirm <id>
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { deleteCourseData } from "../src/lib/services/courseData";
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
if (!db.prepare("SELECT 1 FROM courses WHERE id = ?").get(courseId)) {
  console.error(`No course ${courseId}.`);
  process.exit(1);
}
const res = deleteCourseData(db, dir, courseId);
console.log(
  `Deleted course "${res.title}" (${courseId}) with its sessions, attempts, exposures, assessments, chat, jobs and ${res.files} file(s).${res.isDemo ? " Run npm run db:seed to recreate the demo." : ""}`,
);
db.close();
