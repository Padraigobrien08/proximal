// Online backup of the database plus uploaded PDFs. Safe while the dev server is running.
// Usage: npm run db:backup [-- --label before-demo] [-- --keep 10]
import { backupData } from "../src/lib/db/backup";
import { databasePath, openDatabase } from "../src/lib/db/connection";
import { arg, dataDir, loadDotEnv } from "./_lib";

loadDotEnv();
const dir = dataDir();
const db = openDatabase(databasePath(dir));
const res = await backupData(db, dir, { label: arg("label"), keep: arg("keep") ? Number(arg("keep")) : undefined });
console.log(`Backed up the database to ${res.database}`);
console.log(`Copied ${res.uploadsCopied} uploaded file(s).`);
if (res.pruned.length) console.log(`Removed ${res.pruned.length} older backup(s): ${res.pruned.join(", ")}`);
console.log("Restore: stop the server, then copy proximal.db (and uploads/) from the backup folder back into the data directory.");
db.close();
