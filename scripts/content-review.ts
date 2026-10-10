// Mark a question owner_reviewed (or excluded / back to authored_fixture) AFTER a person has actually checked it.
// Usage: npm run content:review -- --question S5-A --status owner_reviewed --by "Your Name"
//        npm run content:review -- --list
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { getQuestion, setQuestionStatus } from "../src/lib/db/repo";
import { arg, dataDir, flag, loadDotEnv } from "./_lib";

loadDotEnv();
const db = openDatabase(databasePath(dataDir()));
runMigrations(db);

if (flag("list")) {
  const rows = db.prepare("SELECT id, skill_id, status, reviewed_by, reviewed_at FROM questions ORDER BY id").all() as {
    id: string;
    skill_id: string;
    status: string;
    reviewed_by: string | null;
    reviewed_at: number | null;
  }[];
  for (const r of rows) {
    console.log(`${r.id.padEnd(10)} ${r.skill_id.padEnd(8)} ${r.status.padEnd(17)} ${r.reviewed_by ? `${r.reviewed_by} @ ${new Date(r.reviewed_at!).toISOString()}` : ""}`);
  }
  process.exit(0);
}

const id = arg("question");
const status = arg("status");
const by = arg("by");
if (!id || !status || !["owner_reviewed", "excluded", "authored_fixture"].includes(status)) {
  console.error('Usage: npm run content:review -- --question <id> --status owner_reviewed|excluded|authored_fixture --by "<reviewer name>"');
  process.exit(1);
}
if (status === "owner_reviewed" && !by) {
  console.error("--by is required: record who actually reviewed the question. Never mark content reviewed on someone's behalf.");
  process.exit(1);
}
const q = getQuestion(db, id);
if (!q) {
  console.error(`No question ${id}.`);
  process.exit(1);
}
console.log(`Question ${q.id} (${q.skillId}, family ${q.familyId}${q.isTransfer ? ", transfer" : ""})\n${q.prompt}\nReference: ${q.reference.summary}`);
setQuestionStatus(db, id, status as "owner_reviewed" | "excluded" | "authored_fixture", status === "authored_fixture" ? null : (by ?? null), status === "authored_fixture" ? null : Date.now());
console.log(`Status: ${q.status} -> ${status}${by ? ` (by ${by})` : ""}. Questions are immutable otherwise; sessions keep their frozen copy.`);
db.close();
