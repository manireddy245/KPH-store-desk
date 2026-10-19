import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { connect } from '../src/db/connect.js';
import { startEmbeddedPostgres } from '../src/db/embedded.js';
import { createDatabase, ensureAppRole, migrate } from '../src/db/migrate.js';

/** One throwaway PostgreSQL for the whole test run, in a temp folder. */
export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), 'kph-test-pg-'));
  const port = 54400 + Math.floor(Math.random() * 500);
  const pg = await startEmbeddedPostgres({ dir: join(dir, 'pg'), port, password: 'test-owner' });
  const admin = connect(pg.url('postgres'), { max: 1 });
  await createDatabase(admin, 'storedesk_test');
  await ensureAppRole(admin, 'test-app');
  await admin.end();
  const owner = connect(pg.url('storedesk_test'), { max: 1 });
  await migrate(owner);
  await owner.end();

  project.provide('ownerUrl', pg.url('storedesk_test'));
  project.provide('appUrl', `postgres://storedesk_app:test-app@127.0.0.1:${port}/storedesk_test`);
  project.provide('dataDir', dir);

  return async () => {
    await pg.stop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
    dataDir: string;
  }
}
