import { loadConfig } from './config.js';
import { Workspaces } from './db/workspace.js';
import { readBackupFile, restoreBackupData, writeBackup } from './services/backup.js';

/**
 * Maintenance commands (stop the server first):
 *   pnpm backup                 → backup of the active workspace
 *   pnpm restore <file.json.gz> → replace the active workspace's data with a backup
 *   pnpm db:reset-sample        → wipe and reload the SAMPLE workspace (never touches real data)
 */
const [cmd, arg] = process.argv.slice(2);
const db = new Workspaces(loadConfig());
await db.start();
try {
  if (cmd === 'backup') {
    const r = await writeBackup(db.owner, db.name, db.backupDir, 'manual');
    console.log(`Backup written: ${db.backupDir}\\${r.file}`);
  } else if (cmd === 'restore') {
    if (!arg) throw new Error('Usage: pnpm restore <backup file>');
    const data = readBackupFile(arg);
    const safety = await writeBackup(db.owner, db.name, db.backupDir, 'pre-restore');
    console.log(`Safety backup of current data: ${safety.file}`);
    const counts = await restoreBackupData(db.owner, data);
    console.log(`Restored into ${db.name}:`, counts);
  } else if (cmd === 'reset-sample') {
    if (db.name !== 'sample') throw new Error('The active workspace is REAL DATA. Reset only works on the sample workspace.');
    await db.resetSample();
    console.log('Sample workspace reset and reloaded.');
  } else {
    console.log('Commands: backup | restore <file> | reset-sample');
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.stop();
}
