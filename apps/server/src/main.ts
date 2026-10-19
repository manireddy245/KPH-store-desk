import { networkInterfaces } from 'node:os';
import { istDate } from '@kph/core';
import { loadConfig } from './config.js';
import { Workspaces } from './db/workspace.js';
import { buildApp } from './http/app.js';
import { writeBackup } from './services/backup.js';
import { reconcileStock } from './services/products.js';
import { getSettings } from './services/settings.js';

const config = loadConfig();
const db = new Workspaces(config);

console.log(`[kph] data folder: ${config.dataDir}`);
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
 * Automatic daily backup: once a day after the configured hour (India time),
 * plus at start-up if the last good backup is more than a day old. Also checks
 * that stock balances still match the stock ledger.
 */
async function dailyJobs() {
  try {
    const s = await getSettings(db.app);
    const [last] = await db.app<{ at: Date }[]>`select at from backups_log where ok and kind = 'auto' order by id desc limit 1`;
    const hourIst = Number(new Date(Date.now() + 5.5 * 3600000).toISOString().slice(11, 13));
    const doneToday = last && istDate(last.at) === istDate();
    const stale = !last || Date.now() - last.at.getTime() > 26 * 3600000;
    if (stale || (!doneToday && hourIst >= s.autoBackupHour)) {
      const r = await writeBackup(db.owner, db.name, db.backupDir, 'auto');
      console.log(`[backup] ${r.file} (${Math.round(r.sizeBytes / 1024)} KB)`);
    }
    const mismatches = await reconcileStock(db.app);
    if (mismatches.length) console.error('[stock] balance does not match stock ledger for', mismatches);
  } catch (e) {
    console.error('[daily jobs] failed:', (e as Error).message);
  }
}
setTimeout(dailyJobs, 30_000);
const timer = setInterval(dailyJobs, 15 * 60_000);

async function shutdown() {
  clearInterval(timer);
  await app.close();
  await db.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
