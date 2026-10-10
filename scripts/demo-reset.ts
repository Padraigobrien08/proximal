// Clears learner records for the DEMO course only, then re-seeds. Never touches imported courses or uploads.
import { loadFixtures, SAMPLE_PDF_PATH } from "../src/lib/content/fixtures";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { DEMO_COURSE_ID, seedDemo } from "../src/lib/services/seed";
import { dataDir, flag, loadDotEnv } from "./_lib";

loadDotEnv();
if (!flag("yes")) {
  console.error("demo:reset deletes all sessions, attempts, exposures and assessments for the demo course.\nRe-run with: npm run demo:reset -- --yes");
  process.exit(1);
}
const dir = dataDir();
const db = openDatabase(databasePath(dir));
runMigrations(db);
const course = db.prepare("SELECT id, is_demo FROM courses WHERE id = ?").get(DEMO_COURSE_ID) as { id: string; is_demo: number } | undefined;
if (course && course.is_demo !== 1) {
  console.error("Guard: the demo course id exists but is not marked as demo. Refusing to reset.");
  process.exit(1);
}
const res = db.transaction(() => {
  const sessions = db
    .prepare("DELETE FROM sessions WHERE is_demo = 1 AND topic_id IN (SELECT id FROM topics WHERE course_id = ?)")
    .run(DEMO_COURSE_ID).changes;
  db.prepare("DELETE FROM review_states WHERE skill_id IN (SELECT s.id FROM skills s JOIN units u ON u.id = s.unit_id JOIN topics t ON t.id = u.topic_id WHERE t.course_id = ?)").run(DEMO_COURSE_ID);
  return sessions;
})();
await seedDemo({ db, now: Date.now(), dataDir: dir, samplePdfPath: SAMPLE_PDF_PATH, fixtures: loadFixtures() });
console.log(`Removed ${res} demo session(s) and their attempts/exposures/assessments. Imported courses and uploads untouched.`);
db.close();
