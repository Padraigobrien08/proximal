import { loadFixtures, SAMPLE_PDF_PATH } from "../src/lib/content/fixtures";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { seedDemo } from "../src/lib/services/seed";
import { dataDir, loadDotEnv } from "./_lib";

loadDotEnv();
const dir = dataDir();
const db = openDatabase(databasePath(dir));
runMigrations(db);
const report = await seedDemo({ db, now: Date.now(), dataDir: dir, samplePdfPath: SAMPLE_PDF_PATH, fixtures: loadFixtures() });
console.log(
  [
    report.courseCreated ? "Created demo course 'AI classification demo'." : "Demo course already present (unchanged).",
    report.sourceCreated ? "Registered the authored sample lecture." : "Sample lecture already registered.",
    `Inserted ${report.questionsInserted} new fixture question(s); updated ${report.questionsUpdated} unreviewed fixture question(s) to a newer authored version (owner-reviewed questions are never changed).`,
    report.sourceRefreshed ? "Refreshed the demo source text from the lecture fixture." : "Demo source text unchanged.",
    `Refreshed ${report.unitsRefreshed} demo explanation(s).`,
    `Inserted or updated ${report.pacerContextsUpdated} authored PACER learning context(s).`,
    report.pdfCreated ? `Generated ${SAMPLE_PDF_PATH}.` : `Sample PDF up to date at ${SAMPLE_PDF_PATH}.`,
    "Learner records and imported uploads were not touched.",
  ].join("\n"),
);
db.close();
