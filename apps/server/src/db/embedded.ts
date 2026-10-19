import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';

/**
 * Built-in PostgreSQL: real PostgreSQL binaries shipped as an npm package,
 * so the shop server PC needs no separate database installer.
 *
 * If the server was killed (power cut, closed window), PostgreSQL may still be
 * running from last time. In that case we connect to it instead of starting a second one.
 */
export async function startEmbeddedPostgres(opts: { dir: string; port: number; password: string }) {
  mkdirSync(opts.dir, { recursive: true });
  const url = (db: string) => `postgres://postgres:${encodeURIComponent(opts.password)}@127.0.0.1:${opts.port}/${db}`;

  if (existsSync(join(opts.dir, 'postmaster.pid')) && (await canConnect(url('postgres')))) {
    console.log('[postgres] already running — reusing it');
    return { url, stop: async () => {} };
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
  await pg.start();
  return { url, stop: () => pg.stop() };
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
