// Clears learner records for the DEMO course only, then re-seeds. Never touches imported courses or uploads.
import { loadFixtures, SAMPLE_PDF_PATH } from "../src/lib/content/fixtures";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { resetDemoLearner, seedDemo } from "../src/lib/services/seed";
import { dataDir, flag, loadDotEnv } from "./_lib";

loadDotEnv();
if (!flag("yes")) {
  console.error("demo:reset deletes all learner records for the demo course: sessions, attempts, exposures, assessments, chat, approach choices and connections.\nRe-run with: npm run demo:reset -- --yes");
  process.exit(1);
}
const dir = dataDir();
const db = openDatabase(databasePath(dir));
runMigrations(db);
let res;
try {
  res = resetDemoLearner(db);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
await seedDemo({ db, now: Date.now(), dataDir: dir, samplePdfPath: SAMPLE_PDF_PATH, fixtures: loadFixtures() });
console.log(
  `Removed ${res.sessions} demo session(s) and their attempts/exposures/assessments, ${res.chatThreads} chat thread(s), ` +
    `${res.decisions} approach decision(s), ${res.connections} learner connection(s) and ${res.jobs} grading job(s). Imported courses and uploads untouched.`,
);
db.close();
