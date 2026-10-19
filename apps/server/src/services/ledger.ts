import { formatDocNumber } from '@kph/core';
import type { Q, Tx } from '../db/connect.js';
import type { Ctx } from './common.js';

/**
 * Double-entry posting. Every bill, receipt and cancellation posts a voucher here,
 * so ledgers, Day Book and Tally export in later phases read data that already exists.
 * PostgreSQL rejects any voucher whose debits and credits differ.
 */

export type SystemLedger = 'cash' | 'upi' | 'card' | 'bank' | 'cheque' | 'sales' | 'output_cgst' | 'output_sgst' | 'output_igst' | 'round_off'
  | 'purchases' | 'input_cgst' | 'input_sgst' | 'input_igst' | 'freight_in' | 'sales_returns' | 'purchase_returns';

export async function systemLedgerIds(q: Q): Promise<Record<SystemLedger, number>> {
  const rows = await q<{ id: number; system_code: SystemLedger }[]>`select id, system_code from ledgers where system_code is not null`;
  return Object.fromEntries(rows.map((r) => [r.system_code, r.id])) as Record<SystemLedger, number>;
}

export interface VoucherLine {
  ledgerId: number;
  /** Positive = debit, negative = credit. */
  amountPaise: number;
}

export async function postVoucher(
  tx: Tx,
  ctx: Pick<Ctx, 'userId' | 'deviceId'>,
  v: { vtype: string; vdate: string; narration?: string; refType?: string; refId?: number; reversesId?: number; lines: VoucherLine[] },
): Promise<number | null> {
  // merge lines for the same ledger, drop zeros
  const merged = new Map<number, number>();
  for (const l of v.lines) merged.set(l.ledgerId, (merged.get(l.ledgerId) ?? 0) + l.amountPaise);
  const lines = [...merged].filter(([, amt]) => amt !== 0);
  if (lines.length === 0) return null;
  const [row] = await tx<{ id: number }[]>`
    insert into vouchers (vtype, vdate, narration, ref_type, ref_id, reverses_id, user_id, device_id)
    values (${v.vtype}, ${v.vdate}, ${v.narration ?? null}, ${v.refType ?? null}, ${v.refId ?? null},
            ${v.reversesId ?? null}, ${ctx.userId}, ${ctx.deviceId})
    returning id`;
  const id = row!.id;
  await tx`insert into voucher_lines ${tx(
    lines.map(([ledgerId, amt]) => ({ voucher_id: id, ledger_id: ledgerId, dr_paise: amt > 0 ? amt : 0, cr_paise: amt < 0 ? -amt : 0 })),
  )}`;
  return id;
}

/** Post the exact opposite of an existing voucher. The original stays untouched. */
export async function reverseVoucher(tx: Tx, ctx: Pick<Ctx, 'userId' | 'deviceId'>, voucherId: number, vdate: string, narration: string) {
  const [orig] = await tx<{ ref_type: string | null; ref_id: number | null }[]>`select ref_type, ref_id from vouchers where id = ${voucherId}`;
  const lines = await tx<{ ledger_id: number; dr_paise: number; cr_paise: number }[]>`
    select ledger_id, dr_paise, cr_paise from voucher_lines where voucher_id = ${voucherId}`;
  return postVoucher(tx, ctx, {
    vtype: 'reversal',
    vdate,
    narration,
    refType: orig?.ref_type ?? undefined,
    refId: orig?.ref_id ?? undefined,
    reversesId: voucherId,
    lines: lines.map((l) => ({ ledgerId: l.ledger_id, amountPaise: l.cr_paise - l.dr_paise })),
  });
}

export async function createPartyLedger(q: Q, type: 'customer' | 'supplier', partyId: number, name: string, openingDrPaise = 0) {
  const group = type === 'customer' ? 'Sundry Debtors' : 'Sundry Creditors';
  const [l] = await q<{ id: number }[]>`
    insert into ledgers (name, group_id, party_type, party_id, opening_dr_paise)
    select ${name}, id, ${type}, ${partyId}, ${openingDrPaise} from ledger_groups where name = ${group}
    returning id`;
  return l!.id;
}

/** Balance of a ledger: positive = debit (for a customer: they owe us). */
export async function ledgerBalance(q: Q, ledgerId: number): Promise<number> {
  const [r] = await q<{ bal: number }[]>`
    select l.opening_dr_paise + coalesce((select sum(dr_paise - cr_paise) from voucher_lines where ledger_id = l.id), 0) as bal
    from ledgers l where l.id = ${ledgerId}`;
  return r?.bal ?? 0;
}

/**
 * Next number in a gapless series. The row lock is held until the transaction
 * commits, so two counters can never get the same number, and a failed bill
 * rolls the counter back (no gaps).
 */
export async function nextDocNumber(tx: Tx, docType: string, prefix: string, fyStart: number) {
  const [r] = await tx<{ seq: number }[]>`
    insert into doc_sequences (doc_type, fy_start, next_seq) values (${docType}, ${fyStart}, 2)
    on conflict (doc_type, fy_start) do update set next_seq = doc_sequences.next_seq + 1
    returning next_seq - 1 as seq`;
  const seq = r!.seq;
  return { seq, number: formatDocNumber(prefix, fyStart, seq) };
}
