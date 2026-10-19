import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKUP_TABLES } from '../src/services/backup.js';
import { makeHarness } from './harness.js';

let h: Awaited<ReturnType<typeof makeHarness>>;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(() => h.close());

/** Tables that are deliberately not backed up. Every other table must be. */
const NOT_BACKED_UP = ['sessions', 'schema_migrations', 'backups_log'];

describe('backups', () => {
  it('cover every table (a new table must be added to BACKUP_TABLES)', async () => {
    const rows = await h.app<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
    const missing = rows.map((r) => r.table_name).filter((t) => !NOT_BACKED_UP.includes(t) && !(BACKUP_TABLES as readonly string[]).includes(t));
    expect(missing).toEqual([]);
  });
});
