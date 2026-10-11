import { backupData, pendingMigrations } from "../src/lib/db/backup";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { MIGRATIONS_DIR, runMigrations } from "../src/lib/db/migrate";
import { dataDir, loadDotEnv } from "./_lib";

loadDotEnv();
const dir = dataDir();
const file = databasePath(dir);
const db = openDatabase(file);
const pending = pendingMigrations(db, MIGRATIONS_DIR);
const hasData = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'courses'").get();
if (pending.length > 0 && hasData) {
  const b = await backupData(db, dir, { label: "pre-migrate" });
  console.log(`Backed up before migrating: ${b.database}`);
}
const ran = runMigrations(db);
console.log(ran.length ? `Applied migrations: ${ran.join(", ")}` : "Database already up to date.");
console.log(`Database: ${file}`);
db.close();
