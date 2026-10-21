// Attach an owner-authored question bank (JSON, same schema as fixtures/questions.json) to existing skills.
// Usage: npm run questions:import -- --file path/to/bank.json [--course <courseId>]
// Imported questions start as authored_fixture; mark them reviewed with content:review after checking them.
import { readFileSync } from "node:fs";
import { questionBankSchema } from "../src/lib/content/schemas";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { citePages, getQuestion, getSkill, getUnit, insertQuestion, legacyCitationSource } from "../src/lib/db/repo";
import { arg, dataDir, loadDotEnv } from "./_lib";

loadDotEnv();
const file = arg("file");
if (!file) {
  console.error("Usage: npm run questions:import -- --file bank.json [--course <courseId>]");
  process.exit(1);
}
const bank = questionBankSchema.parse(JSON.parse(readFileSync(file, "utf8")));
const db = openDatabase(databasePath(dataDir()));
runMigrations(db);
const course = arg("course");

const result = db.transaction(() => {
  let inserted = 0;
  for (const q of bank.questions) {
    const skill = getSkill(db, q.skillId);
    if (!skill) throw new Error(`Skill ${q.skillId} does not exist. Use the skill ids shown by the course API/export.`);
    const owner = db
      .prepare("SELECT t.course_id AS c FROM skills s JOIN units u ON u.id = s.unit_id JOIN topics t ON t.id = u.topic_id WHERE s.id = ?")
      .get(q.skillId) as { c: string };
    if (course && owner.c !== course) throw new Error(`Skill ${q.skillId} is not in course ${course}.`);
    if (getQuestion(db, q.id)) {
      console.log(`skip ${q.id}: already exists (questions are immutable; use a new id/version)`);
      continue;
    }
    // The bank names pages only: each takes the source the skill's unit cites it from.
    const unitRefs = getUnit(db, skill.unitId)?.sourceRefs ?? [];
    const sourceRefs = citePages(unitRefs, q.sourceRefs.map((r) => r.page), legacyCitationSource(db, owner.c));
    insertQuestion(db, { ...q, sourceRefs, status: q.status === "owner_reviewed" ? "authored_fixture" : q.status });
    inserted += 1;
  }
  return inserted;
})();
console.log(`Inserted ${result} question(s) as authored_fixture. Review them, then run content:review to mark owner_reviewed.`);
db.close();
