import { databasePath, openDatabase } from "../src/lib/db/connection";
import { runMigrations } from "../src/lib/db/migrate";
import { dataDir, loadDotEnv } from "./_lib";

loadDotEnv();
const file = databasePath(dataDir());
const db = openDatabase(file);
const ran = runMigrations(db);
console.log(ran.length ? `Applied migrations: ${ran.join(", ")}` : "Database already up to date.");
console.log(`Database: ${file}`);
db.close();
