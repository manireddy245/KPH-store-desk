import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from './connect.js';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');

/** Applies any new migrations/NNN_*.sql in order, each in its own transaction, then re-applies grants. */
export async function migrate(owner: Sql): Promise<string[]> {
  await owner`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await owner<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const text = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    await owner.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${f})`;
    });
    applied.push(f);
  }
  await owner.unsafe(readFileSync(join(MIGRATIONS_DIR, 'grants.sql'), 'utf8'));
  return applied;
}

export async function schemaVersion(sql: Sql): Promise<string | null> {
  const [r] = await sql<{ name: string }[]>`select max(name) as name from schema_migrations`;
  return r?.name ?? null;
}

/** Create the app login role (cluster-wide) if missing, or update its password. */
export async function ensureAppRole(owner: Sql, password: string) {
  const [exists] = await owner`select 1 from pg_roles where rolname = 'storedesk_app'`;
  const pw = password.replace(/'/g, "''");
  if (!exists) await owner.unsafe(`create role storedesk_app login password '${pw}'`);
  else await owner.unsafe(`alter role storedesk_app login password '${pw}'`);
}

/** Create a UTF-8 database (needed for Telugu), whatever the server default is. */
export async function createDatabase(owner: Sql, name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Bad database name ${name}`);
  await owner.unsafe(`create database ${name} encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
}

export async function assertUtf8(sql: Sql) {
  const [r] = await sql<{ enc: string }[]>`select pg_encoding_to_char(encoding) as enc from pg_database where datname = current_database()`;
  if (r?.enc !== 'UTF8') throw new Error(`Database encoding is ${r?.enc}; Store Desk needs UTF8 for Telugu text`);
}

export async function databaseExists(owner: Sql, name: string) {
  const [r] = await owner`select 1 from pg_database where datname = ${name}`;
  return !!r;
}
