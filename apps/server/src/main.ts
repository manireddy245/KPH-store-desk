import { networkInterfaces } from 'node:os';
import { loadConfig } from './config.js';
import { Workspaces } from './db/workspace.js';
import { buildApp } from './http/app.js';
import { writeBackup } from './services/backup.js';
import { copyBackup } from './services/backupcopy.js';
import { lastClosing, makeDailySummary } from './services/owner.js';
import { reconcileStock } from './services/products.js';
import { getSettings } from './services/settings.js';

const config = loadConfig();
const db = new Workspaces(config);

console.log(`[kph] data folder: ${config.dataDir}`);
// Already running (another black window, or started at login)? Don't start a second copy of the database.
try {
  const res = await fetch(`http://127.0.0.1:${config.port}/api/bootstrap`, { signal: AbortSignal.timeout(3000) });
  if (res.ok) {
    console.log(`\n  Store Desk is already running: open http://localhost:${config.port}\n  (This window isn't needed — you can close it.)\n`);
    process.exit(0);
  }
} catch {
  /* not running: start it */
}
try {
  await db.start();
} catch (e) {
  console.error(`\n[kph] Could not start the database: ${e instanceof Error ? e.message : String(e ?? 'unknown error')}`);
  console.error('[kph] If Store Desk was closed suddenly, wait 10 seconds and start it again. If this keeps happening, restart the computer.\n');
  process.exit(1);
}
const app = await buildApp({ db, webDist: config.webDist, logger: true });
await app.listen({ port: config.port, host: config.host });

console.log(`\n  Kanakapatnam Store Desk is running (${db.name === 'sample' ? 'SAMPLE DATA' : 'REAL DATA'})`);
console.log(`  On this computer:   http://localhost:${config.port}`);
for (const addrs of Object.values(networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === 'IPv4' && !a.internal) console.log(`  On other counters:  http://${a.address}:${config.port}`);
  }
}
console.log('');

/**
 * Daily jobs, made for a server PC that is switched off after the shop closes:
 *  - backup at closing time; if the PC was off by then, the backup is made as soon as it starts next
 *    (and any time the last good backup is more than a day old)
 *  - the owner's daily summary at closing time; a missed one is made the next morning for the day it belongs to
 *  - stock balances checked against the stock ledger
 */
async function dailyJobs() {
  try {
    const s = await getSettings(db.app);
    const closing = lastClosing(s.shopCloseTime);
    const [last] = await db.app<{ at: Date }[]>`select at from backups_log where ok and kind = 'auto' order by id desc limit 1`;
    const stale = !last || Date.now() - last.at.getTime() > 26 * 3600000;
    if (stale || last.at < closing.at) {
      const r = await writeBackup(db.owner, db.name, db.backupDir, 'auto');
      console.log(`[backup] ${r.file} (${Math.round(r.sizeBytes / 1024)} KB)`);
      if (s.backupCopyDir && s.backupPassphrase) {
        try {
          const c = await copyBackup(db.owner, { sourceDir: db.backupDir, file: r.file, copyDir: s.backupCopyDir, passphrase: s.backupPassphrase });
          console.log(`[backup] encrypted copy → ${s.backupCopyDir} (${c.rows} rows checked)`);
        } catch (e) {
          console.error('[backup] copy to the second location failed:', (e as Error).message);
        }
      }
    }
    const [made] = await db.app<{ d: string }[]>`select summary_date::text as d from daily_summaries where summary_date = ${closing.date}`;
    if (!made) {
      await makeDailySummary(db.app, closing.date);
      console.log(`[summary] daily summary made for ${closing.date}`);
    }
    const mismatches = await reconcileStock(db.app);
    if (mismatches.length) console.error('[stock] balance does not match stock ledger for', mismatches);
  } catch (e) {
    console.error('[daily jobs] failed:', (e as Error).message);
  }
}
setTimeout(dailyJobs, 30_000);
const timer = setInterval(dailyJobs, 5 * 60_000);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await app.close();
  await db.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows: the Store Desk window closed, or the PC shutting down — stop the database cleanly
process.on('SIGHUP', shutdown);
process.on('SIGBREAK', shutdown);
