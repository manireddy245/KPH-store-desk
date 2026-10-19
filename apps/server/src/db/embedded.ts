import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';

/**
 * Built-in PostgreSQL: real PostgreSQL binaries shipped as an npm package,
 * so the shop server PC needs no separate database installer.
 *
 * Start-up copes with the ways a shop PC really stops:
 *  - Store Desk window closed / process killed, PostgreSQL still running fine → reuse it.
 *  - PostgreSQL itself killed half-way, leaving helper processes behind → clear them, then start.
 *  - Anything else → give up after a minute with a clear message (never hang).
 */
export async function startEmbeddedPostgres(opts: { dir: string; port: number; password: string }) {
  mkdirSync(opts.dir, { recursive: true });
  const url = (db: string) => `postgres://postgres:${encodeURIComponent(opts.password)}@127.0.0.1:${opts.port}/${db}`;
  const pidFile = join(opts.dir, 'postmaster.pid');

  if (existsSync(pidFile)) {
    if (await canConnect(url('postgres'))) {
      console.log('[postgres] already running — reusing it');
      return { url, stop: async () => {} };
    }
    console.log('[postgres] found a database left over from an unclean stop — clearing it');
    clearLeftovers(pidFile);
  }

  const pg = new EmbeddedPostgres({
    databaseDir: opts.dir,
    user: 'postgres',
    password: opts.password,
    port: opts.port,
    persistent: true,
    // UTF-8 is required for Telugu text. Windows would otherwise default to WIN1252.
    initdbFlags: ['--encoding=UTF8', '--locale=C', '--auth=scram-sha-256'],
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog: () => {},
    onError: (e: unknown) => {
      const s = String(e);
      if (/error|fatal|panic/i.test(s)) console.error('[postgres]', s.trim());
    },
  });
  if (!existsSync(join(opts.dir, 'PG_VERSION'))) {
    await pg.initialise();
  }
  await withTimeout(pg.start(), 60_000, 'The database did not start within a minute. Restart the computer and try again.');
  return { url, stop: () => pg.stop() };
}

/** Kill the old postmaster (if its PID is still alive) and any orphaned helpers of OUR PostgreSQL binary. */
function clearLeftovers(pidFile: string) {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').split(/\r?\n/)[0]);
    if (pid > 0) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* unreadable pid file */
  }
  if (process.platform === 'win32') {
    // Helper processes of the bundled PostgreSQL only — never any other PostgreSQL on this PC.
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Where-Object { $_.CommandLine -like '*@embedded-postgres*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { stdio: 'ignore', timeout: 20_000 },
    );
  }
  // Give Windows a moment to release the files.
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    /* wait */
  }
}

async function canConnect(url: string) {
  const sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
