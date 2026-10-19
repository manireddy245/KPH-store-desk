import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * Built-in PostgreSQL: real PostgreSQL binaries shipped as an npm package,
 * so the shop server PC needs no separate database installer.
 */
export async function startEmbeddedPostgres(opts: { dir: string; port: number; password: string }) {
  mkdirSync(opts.dir, { recursive: true });
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
  return {
    url: (db: string) => `postgres://postgres:${encodeURIComponent(opts.password)}@127.0.0.1:${opts.port}/${db}`,
    stop: () => pg.stop(),
  };
}
