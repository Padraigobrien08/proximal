// Delete a course with all dependent records and its uploaded PDFs.
// Usage: npm run data:delete-course -- --course <id> --confirm <id>
import path from "node:path";
import { BACKUP_MAX_AGE_DAYS, backupsContainingCourse, pruneBackups } from "../src/lib/db/backup";
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
// Backups are whole-database copies taken before the deletion: say which still hold the course, after applying retention.
pruneBackups(path.join(dir, "backups"));
const held = backupsContainingCourse(dir, courseId);
if (held.length > 0) {
  const lastOut = new Date(Math.max(...held.map((b) => b.takenAt)) + BACKUP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  console.log(
    `${held.length} backup(s) in ${path.join(dir, "backups")} still contain this course: ${held.map((b) => b.name).join(", ")}.\n` +
      `They are removed once ${BACKUP_MAX_AGE_DAYS} days old (the last of these from ${lastOut.toISOString().slice(0, 10)}) the next time a backup is ` +
      `taken or a course is deleted; the newest backup is always kept until a newer one exists. To remove them now, delete those ` +
      `folders (each also holds your other courses and learner records).`,
  );
}
db.close();
