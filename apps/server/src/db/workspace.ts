import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_NAMES, type Config, type WorkspaceName } from '../config.js';
import { seedSample } from '../services/seed.js';
import { connect, type Sql } from './connect.js';
import { startEmbeddedPostgres } from './embedded.js';
import { assertUtf8, createDatabase, databaseExists, ensureAppRole, migrate } from './migrate.js';

/**
 * Two completely separate databases:
 *   storedesk_sample — sample data for training/testing, orange banner on every screen
 *   storedesk_live   — the shop's real books, starts empty
 * The active one is remembered in <dataDir>/active-workspace.json.
 */
export class Workspaces {
  name: WorkspaceName = 'sample';
  app!: Sql;
  owner!: Sql;
  private stopPg: (() => Promise<void>) | null = null;
  private url!: (db: string, role: 'owner' | 'app') => string;

  constructor(private config: Config) {}

  get backupDir() {
    return join(this.config.dataDir, 'backups', this.name);
  }

  async start() {
    mkdirSync(this.config.dataDir, { recursive: true });
    const secrets = this.secrets();
    if (this.config.externalOwnerUrl && this.config.externalAppUrlTemplate) {
      const ownerT = this.config.externalOwnerUrl;
      const appT = this.config.externalAppUrlTemplate;
      this.url = (db, role) => (role === 'owner' ? ownerT : appT).replace('{db}', db);
    } else {
      const pg = await startEmbeddedPostgres({ dir: join(this.config.dataDir, 'pgdata'), port: this.config.pgPort, password: secrets.pgOwnerPassword });
      this.stopPg = pg.stop;
      this.url = (db, role) =>
        role === 'owner' ? pg.url(db) : `postgres://storedesk_app:${encodeURIComponent(secrets.pgAppPassword)}@127.0.0.1:${this.config.pgPort}/${db}`;
    }
    const admin = connect(this.url('postgres', 'owner'), { max: 1 });
    try {
      await ensureAppRole(admin, secrets.pgAppPassword);
    } finally {
      await admin.end();
    }
    await this.open(this.readActive());
  }

  private secrets(): { pgOwnerPassword: string; pgAppPassword: string } {
    const f = join(this.config.dataDir, 'secrets.json');
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
    const s = { pgOwnerPassword: randomBytes(24).toString('base64url'), pgAppPassword: randomBytes(24).toString('base64url') };
    writeFileSync(f, JSON.stringify(s, null, 2));
    return s;
  }

  private readActive(): WorkspaceName {
    try {
      const v = JSON.parse(readFileSync(join(this.config.dataDir, 'active-workspace.json'), 'utf8')).workspace;
      return v === 'live' ? 'live' : 'sample';
    } catch {
      return 'sample';
    }
  }

  /** Create (if needed), migrate and connect to a workspace database. */
  async open(name: WorkspaceName) {
    const db = DB_NAMES[name];
    const admin = connect(this.url('postgres', 'owner'), { max: 1 });
    let created = false;
    try {
      if (!(await databaseExists(admin, db))) {
        await createDatabase(admin, db);
        created = true;
      }
    } finally {
      await admin.end();
    }
    const owner = connect(this.url(db, 'owner'), { max: 2 });
    await assertUtf8(owner);
    const applied = await migrate(owner);
    if (applied.length) console.log(`[db] ${db}: applied ${applied.join(', ')}`);
    const app = connect(this.url(db, 'app'), { max: 10 });
    if (created && name === 'sample') {
      console.log('[db] loading sample data…');
      await seedSample(app);
    }
    const old = this.app ? [this.app, this.owner] : [];
    this.app = app;
    this.owner = owner;
    this.name = name;
    writeFileSync(join(this.config.dataDir, 'active-workspace.json'), JSON.stringify({ workspace: name }));
    await Promise.all(old.map((s) => s.end({ timeout: 5 })));
  }

  /** Wipe and re-create the SAMPLE database only. Refuses to touch real data. */
  async resetSample() {
    if (this.name !== 'sample') throw new Error('Reset is only allowed while using the sample workspace');
    await Promise.all([this.app.end({ timeout: 5 }), this.owner.end({ timeout: 5 })]);
    const admin = connect(this.url('postgres', 'owner'), { max: 1 });
    try {
      await admin`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${DB_NAMES.sample} and pid <> pg_backend_pid()`;
      await admin.unsafe(`drop database if exists ${DB_NAMES.sample}`);
    } finally {
      await admin.end();
    }
    this.app = undefined as unknown as Sql;
    await this.open('sample');
  }

  async stop() {
    await Promise.allSettled([this.app?.end({ timeout: 5 }), this.owner?.end({ timeout: 5 })]);
    if (this.stopPg) await this.stopPg();
  }
}
