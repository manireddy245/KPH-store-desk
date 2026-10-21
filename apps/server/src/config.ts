import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Settings come from environment variables so the same code runs on a dev PC,
 * the shop server PC, and in tests.
 *
 *  KPH_DATA_DIR     where the database, backups and secrets live (default %LOCALAPPDATA%\KPHStoreDesk)
 *                   Keep it OUT of OneDrive/Dropbox: syncing a live database corrupts it.
 *  KPH_PORT         web/API port (default 4000)
 *  KPH_HOST         listen address (default 0.0.0.0 so other counters on the LAN can connect)
 *  KPH_PG_PORT      port for the built-in PostgreSQL (default 54329)
 *  KPH_PUBLIC       1 on a cloud server open to the internet: first-time setup needs a one-time code
 *                   (printed in the server log), approving a device with a PIN needs a 6-digit admin
 *                   PIN and wrong tries are limited for the whole server
 *  KPH_PG_OWNER_URL / KPH_PG_APP_URL_TEMPLATE
 *                   use an external PostgreSQL instead of the built-in one. The template
 *                   contains {db}, e.g. postgres://storedesk_app:secret@localhost:5432/{db}
 */
export interface Config {
  dataDir: string;
  port: number;
  host: string;
  pgPort: number;
  externalOwnerUrl?: string;
  externalAppUrlTemplate?: string;
  webDist: string;
}

export function loadConfig(env = process.env): Config {
  const base = env.LOCALAPPDATA ?? join(homedir(), '.local', 'share');
  return {
    dataDir: env.KPH_DATA_DIR ?? join(base, 'KPHStoreDesk'),
    port: Number(env.KPH_PORT ?? 4000),
    host: env.KPH_HOST ?? '0.0.0.0',
    pgPort: Number(env.KPH_PG_PORT ?? 54329),
    externalOwnerUrl: env.KPH_PG_OWNER_URL,
    externalAppUrlTemplate: env.KPH_PG_APP_URL_TEMPLATE,
    webDist: env.KPH_WEB_DIST ?? join(import.meta.dirname, '..', '..', 'web', 'dist'),
  };
}

/** Running on the open internet (cloud server)? */
export const isPublic = (env = process.env) => env.KPH_PUBLIC === '1';

export type WorkspaceName = 'sample' | 'live';
export const DB_NAMES: Record<WorkspaceName, string> = {
  sample: 'storedesk_sample',
  live: 'storedesk_live',
};
