import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Sql } from '../db/connect.js';
import { readBackup } from './backup.js';

/**
 * Second copy of every automatic backup, encrypted, in another place: a USB drive, a shared
 * folder on another PC, or a Google Drive / OneDrive folder that syncs to the cloud. The copy
 * is opened and checked after it is written, so a broken copy is noticed the same day.
 *
 * File format: "KPHENC1\n" | salt (16) | iv (12) | GCM tag (16) | AES-256-GCM(backup .json.gz)
 * The key comes from the admin's passphrase (scrypt). Without the passphrase the copy can't be read
 * — by anyone, including us — so it must be written down and kept safe.
 */

const MAGIC = Buffer.from('KPHENC1\n');
const KEEP = 30;

function key(passphrase: string, salt: Buffer) {
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function isEncrypted(buf: Buffer) {
  return buf.subarray(0, MAGIC.length).equals(MAGIC);
}

export function encryptBackup(plain: Buffer, passphrase: string): Buffer {
  if (passphrase.length < 8) throw new Error('The backup passphrase must be at least 8 characters');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(passphrase, salt), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export function decryptBackup(buf: Buffer, passphrase: string): Buffer {
  if (!isEncrypted(buf)) throw new Error('This is not an encrypted Store Desk backup');
  let o = MAGIC.length;
  const salt = buf.subarray(o, (o += 16));
  const iv = buf.subarray(o, (o += 12));
  const tag = buf.subarray(o, (o += 16));
  const d = createDecipheriv('aes-256-gcm', key(passphrase, salt), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(buf.subarray(o)), d.final()]);
  } catch {
    throw new Error('Wrong passphrase, or the file is damaged');
  }
}

/** Encrypt a local backup into the copy folder, check it opens, keep the last 30. */
export async function copyBackup(owner: Sql, input: { sourceDir: string; file: string; copyDir: string; passphrase: string }) {
  const name = `${input.file}.enc`;
  try {
    const plain = readFileSync(join(input.sourceDir, basename(input.file)));
    const enc = encryptBackup(plain, input.passphrase);
    mkdirSync(input.copyDir, { recursive: true });
    writeFileSync(join(input.copyDir, name), enc);
    // the restore check: read the copy back from the second location and open it
    const back = decryptBackup(readFileSync(join(input.copyDir, name)), input.passphrase);
    const data = readBackup(back);
    const rows = Object.values(data.counts).reduce((t, n) => t + n, 0);
    await owner`insert into backups_log (kind, file, size_bytes, ok, location) values ('copy', ${name}, ${enc.length}, true, ${input.copyDir})`;
    prune(input.copyDir);
    return { file: name, sizeBytes: enc.length, rows };
  } catch (e) {
    await owner`insert into backups_log (kind, file, ok, error, location) values ('copy', ${name}, false, ${(e as Error).message}, ${input.copyDir})`;
    throw e;
  }
}

function prune(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('storedesk-') && f.endsWith('-auto.json.gz.enc'))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP))) unlinkSync(join(dir, f));
}

export function listCopies(dir: string) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json.gz.enc'))
      .map((f) => ({ file: f, sizeBytes: statSync(join(dir, f)).size, at: statSync(join(dir, f)).mtime }))
      .sort((a, b) => b.at.getTime() - a.at.getTime());
  } catch {
    return [];
  }
}

export async function backupStatus(owner: Sql, copyDir: string, passphraseSet: boolean) {
  const [local] = await owner<{ at: Date; file: string; ok: boolean; error: string | null }[]>`select at, file, ok, error from backups_log where kind in ('auto', 'manual') order by id desc limit 1`;
  const [copy] = await owner<{ at: Date; file: string; ok: boolean; error: string | null; location: string | null }[]>`select at, file, ok, error, location from backups_log where kind = 'copy' order by id desc limit 1`;
  return {
    local: local ?? null,
    copy: copy ?? null,
    copyDir,
    passphraseSet,
    copiesKept: copyDir ? listCopies(copyDir).length : 0,
    configured: !!copyDir && passphraseSet,
  };
}
