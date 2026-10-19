import { istDate, mulDivRound } from '@kph/core';
import type { Q, Sql, Tx } from '../db/connect.js';
import { createExpense } from './accounts.js';
import { AppError, audit, can, requirePerm, type Ctx } from './common.js';

/**
 * Trade partners: painters, masons, contractors… who bring customers to the shop. Kept apart from
 * customers. A partner can be tagged on any bill (and a site); rewards are earned per bill from the
 * rules of the partner's type, taken back on returns and cancellations, and paid out as an expense.
 */

const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

// ------------------------------------------------------------------ types & rules

export async function listTypes(q: Q) {
  const types = await q<{ id: number; name: string; active: boolean; sort: number; partners: number }[]>`
    select t.id, t.name, t.active, t.sort, (select count(*)::int from partners p where p.type_id = t.id and p.active) as partners
    from partner_types t order by t.sort, t.name`;
  const rules = await q<{ id: number; type_id: number; category_id: number | null; category_name: string | null; mode: 'percent' | 'per_unit'; value: number; active: boolean }[]>`
    select r.id, r.type_id, r.category_id, c.name as category_name, r.mode, r.value, r.active
    from partner_reward_rules r left join categories c on c.id = r.category_id where r.active order by r.type_id, c.name nulls first`;
  return types.map((t) => ({ ...t, rules: rules.filter((r) => r.type_id === t.id) }));
}

export async function saveType(sql: Sql, ctx: Ctx, id: number | null, input: { name?: string; active?: boolean }) {
  requirePerm(ctx, 'partners.rewards', 'Only admin can change partner types');
  const name = clean(input.name);
  if (id == null) {
    if (!name) throw new AppError(400, 'NAME_REQUIRED', 'Give the type a name');
    const [dup] = await sql`select 1 from partner_types where lower(name) = ${name.toLowerCase()}`;
    if (dup) throw new AppError(409, 'DUPLICATE', `"${name}" already exists`);
    const [t] = await sql<{ id: number }[]>`insert into partner_types (name, sort) values (${name}, (select coalesce(max(sort), 0) + 1 from partner_types)) returning id`;
    return { id: t!.id };
  }
  await sql`update partner_types set name = coalesce(${name}, name), active = coalesce(${input.active ?? null}, active) where id = ${id}`;
  return { id };
}

/** Replace the reward rules of one partner type. */
export async function setRules(sql: Sql, ctx: Ctx, typeId: number, rules: { categoryId: number | null; mode: 'percent' | 'per_unit'; value: number }[]) {
  requirePerm(ctx, 'partners.rewards', 'Only admin can change partner rewards');
  for (const r of rules) {
    if (!Number.isSafeInteger(r.value) || r.value < 0) throw new AppError(400, 'BAD_VALUE', 'Reward must be zero or more');
    if (r.mode === 'percent' && r.value > 2000) throw new AppError(400, 'BAD_VALUE', 'A reward above 20% of the bill looks wrong');
  }
  const keys = rules.map((r) => r.categoryId ?? 0);
  if (new Set(keys).size !== keys.length) throw new AppError(400, 'DUPLICATE', 'Only one rule per category (and one for "all other items")');
  return sql.begin(async (tx) => {
    await tx`delete from partner_reward_rules where type_id = ${typeId}`;
    if (rules.length) await tx`insert into partner_reward_rules ${tx(rules.map((r) => ({ type_id: typeId, category_id: r.categoryId, mode: r.mode, value: r.value })))}`;
    await audit(tx, ctx, 'partner.rules', { entity: 'partner_type', entityId: typeId, details: { rules } });
    return { ok: true };
  });
}

// ------------------------------------------------------------------ partners

export interface PartnerInput {
  name?: string;
  phone?: string | null;
  area?: string | null;
  typeId?: number;
  notes?: string | null;
  joinedOn?: string;
  active?: boolean;
  customerId?: number | null;
  language?: 'te' | 'en' | null;
}

export async function createPartner(sql: Sql, ctx: Ctx, input: PartnerInput & { name: string; typeId: number }, opts: { isSample?: boolean } = {}) {
  requirePerm(ctx, 'partners.manage');
  const name = input.name.trim();
  if (name.length < 2) throw new AppError(400, 'BAD_NAME', 'Name is too short');
  const phone = clean(input.phone);
  if (phone && !/^[+\d][\d\s-]{6,15}$/.test(phone)) throw new AppError(400, 'BAD_PHONE', 'Phone number does not look right');
  if (phone) {
    const [dup] = await sql<{ name: string }[]>`select name from partners where phone = ${phone} and active limit 1`;
    if (dup) throw new AppError(409, 'DUPLICATE_PHONE', `${dup.name} already has this phone number`);
  }
  const [t] = await sql`select 1 from partner_types where id = ${input.typeId} and active`;
  if (!t) throw new AppError(400, 'BAD_TYPE', 'Choose the type (painter, mason…)');
  const [p] = await sql<{ id: number }[]>`
    insert into partners (name, phone, area, type_id, notes, joined_on, customer_id, language, is_sample)
    values (${name}, ${phone}, ${clean(input.area)}, ${input.typeId}, ${clean(input.notes)}, ${input.joinedOn ?? istDate()}, ${input.customerId ?? null}, ${input.language ?? null}, ${opts.isSample ?? false})
    returning id`;
  await audit(sql, ctx, 'partner.created', { entity: 'partner', entityId: p!.id, details: { name, typeId: input.typeId } });
  return { id: p!.id };
}

export async function updatePartner(sql: Sql, ctx: Ctx, id: number, input: PartnerInput) {
  requirePerm(ctx, 'partners.manage');
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) {
    if (input.name.trim().length < 2) throw new AppError(400, 'BAD_NAME', 'Name is too short');
    set.name = input.name.trim();
  }
  if (input.phone !== undefined) set.phone = clean(input.phone);
  if (input.area !== undefined) set.area = clean(input.area);
  if (input.typeId !== undefined) set.type_id = input.typeId;
  if (input.notes !== undefined) set.notes = clean(input.notes);
  if (input.joinedOn !== undefined) set.joined_on = input.joinedOn;
  if (input.active !== undefined) set.active = input.active;
  if (input.customerId !== undefined) set.customer_id = input.customerId;
  if (input.language !== undefined) set.language = input.language;
  if (!Object.keys(set).length) return { id };
  const [p] = await sql<{ id: number }[]>`update partners set ${sql(set)} where id = ${id} returning id`;
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Partner not found');
  await audit(sql, ctx, 'partner.updated', { entity: 'partner', entityId: id, details: input as Record<string, unknown> });
  return { id };
}

/** All partners with this period's business, last bill and reward balance. */
export async function listPartners(q: Q, f: { search?: string; typeId?: number; includeInactive?: boolean; from?: string; to?: string } = {}) {
  const search = f.search?.trim() ? `%${f.search.trim().toLowerCase()}%` : null;
  const from = f.from ?? `${istDate().slice(0, 8)}01`;
  const to = f.to ?? istDate();
  return q<{ id: number; name: string; phone: string | null; area: string | null; type_id: number; type_name: string; joined_on: string; active: boolean; customer_id: number | null; language: string | null; notes: string | null; bills: number; sales_paise: number; last_bill: string | null; reward_balance_paise: number; days_since: number | null }[]>`
    select p.id, p.name, p.phone, p.area, p.type_id, t.name as type_name, p.joined_on, p.active, p.customer_id, p.language, p.notes,
           coalesce(s.bills, 0)::int as bills, coalesce(s.sales, 0)::bigint as sales_paise,
           (select max(si.invoice_date)::text from invoice_partners ip join sales_invoices si on si.id = ip.invoice_id where ip.partner_id = p.id and si.status = 'posted') as last_bill,
           coalesce((select sum(amount_paise) from partner_rewards r where r.partner_id = p.id), 0)::bigint as reward_balance_paise,
           (current_date - (select max(si.invoice_date) from invoice_partners ip join sales_invoices si on si.id = ip.invoice_id where ip.partner_id = p.id and si.status = 'posted'))::int as days_since
    from partners p join partner_types t on t.id = p.type_id
    left join (
      select ip.partner_id, count(*) as bills, sum(si.total_paise) as sales
      from invoice_partners ip join sales_invoices si on si.id = ip.invoice_id
      where si.status = 'posted' and si.invoice_date between ${from} and ${to}
      group by ip.partner_id
    ) s on s.partner_id = p.id
    where (${f.includeInactive ?? false} or p.active)
      and (${f.typeId ?? null}::int is null or p.type_id = ${f.typeId ?? null})
      and (${search}::text is null or lower(p.name) like ${search} or coalesce(p.phone, '') like ${search} or lower(coalesce(p.area, '')) like ${search})
    order by coalesce(s.sales, 0) desc, lower(p.name)
    limit 2000`;
}

// ------------------------------------------------------------------ tagging bills & rewards

interface LineForReward {
  id: number;
  category_id: number | null;
  taxable_paise: number;
  base_qty_milli: number;
}

/** Reward for each bill line, from the rules of the partner's type (a category rule beats the general one). */
async function lineRewards(tx: Q, typeId: number, lines: LineForReward[]) {
  const rules = await tx<{ category_id: number | null; mode: 'percent' | 'per_unit'; value: number }[]>`
    select category_id, mode, value from partner_reward_rules where type_id = ${typeId} and active`;
  const out: Record<string, number> = {};
  for (const l of lines) {
    const rule = rules.find((r) => r.category_id != null && r.category_id === l.category_id) ?? rules.find((r) => r.category_id == null);
    if (!rule || !rule.value) continue;
    const reward = rule.mode === 'percent' ? mulDivRound(Math.max(l.taxable_paise, 0), rule.value, 10000) : mulDivRound(rule.value, l.base_qty_milli, 1000);
    if (reward > 0) out[String(l.id)] = reward;
  }
  return out;
}

/** Tag a partner (and site) on a bill and credit their reward. Used when billing and afterwards. */
export async function tagInvoicePartner(tx: Tx, ctx: Ctx, invoiceId: number, partnerId: number, siteId: number | null) {
  const [p] = await tx<{ id: number; name: string; type_id: number; active: boolean }[]>`select id, name, type_id, active from partners where id = ${partnerId}`;
  if (!p || !p.active) throw new AppError(400, 'NO_PARTNER', 'Partner not found or inactive');
  if (siteId) {
    const [s] = await tx`select 1 from partner_sites where id = ${siteId} and partner_id = ${partnerId}`;
    if (!s) throw new AppError(400, 'BAD_SITE', 'That site is not one of this partner’s sites');
  }
  const [inv] = await tx<{ status: string; number: string }[]>`select status, number from sales_invoices where id = ${invoiceId}`;
  if (!inv) throw new AppError(404, 'NOT_FOUND', 'Bill not found');
  if (inv.status !== 'posted') throw new AppError(400, 'CANCELLED', 'This bill is cancelled');
  const [already] = await tx`select 1 from invoice_partners where invoice_id = ${invoiceId}`;
  if (already) throw new AppError(409, 'ALREADY_TAGGED', `Bill ${inv.number} already has a partner`);
  await tx`insert into invoice_partners (invoice_id, partner_id, site_id, tagged_by) values (${invoiceId}, ${partnerId}, ${siteId}, ${ctx.userId})`;
  const lines = await tx<LineForReward[]>`
    select l.id, p.category_id, l.taxable_paise, l.base_qty_milli
    from sales_invoice_lines l join products p on p.id = l.product_id where l.invoice_id = ${invoiceId}`;
  // returns made before tagging don't earn
  const returned = await tx<{ invoice_line_id: number; base: number; taxable: number }[]>`
    select cl.invoice_line_id, sum(cl.base_qty_milli)::bigint as base, sum(cl.taxable_paise)::bigint as taxable
    from credit_note_lines cl join credit_notes cn on cn.id = cl.credit_note_id
    where cn.invoice_id = ${invoiceId} and cn.status = 'posted' group by cl.invoice_line_id`;
  for (const l of lines) {
    const r = returned.find((x) => x.invoice_line_id === l.id);
    if (r) {
      l.base_qty_milli -= r.base;
      l.taxable_paise -= r.taxable;
    }
  }
  const per = await lineRewards(tx, p.type_id, lines.filter((l) => l.base_qty_milli > 0));
  const total = Object.values(per).reduce((t, v) => t + v, 0);
  if (total > 0)
    await tx`insert into partner_rewards (partner_id, kind, amount_paise, invoice_id, details, note, user_id)
             values (${partnerId}, 'earned', ${total}, ${invoiceId}, ${tx.json(per)}, ${`Bill ${inv.number}`}, ${ctx.userId})`;
  await audit(tx, ctx, 'partner.tagged', { entity: 'sales_invoice', entityId: invoiceId, details: { number: inv.number, partnerId, partner: p.name, siteId, rewardPaise: total } });
  return { rewardPaise: total };
}

export async function tagInvoice(sql: Sql, ctx: Ctx, invoiceId: number, partnerId: number, siteId: number | null) {
  requirePerm(ctx, 'partners.manage');
  return sql.begin((tx) => tagInvoicePartner(tx, ctx, invoiceId, partnerId, siteId));
}

/** Cancelled bill: take back whatever reward is still standing on it. */
export async function reverseRewardsOnCancel(tx: Tx, ctx: Ctx, invoiceId: number, number: string) {
  const [r] = await tx<{ partner_id: number; net: number }[]>`
    select partner_id, sum(amount_paise)::bigint as net from partner_rewards
    where invoice_id = ${invoiceId} and kind in ('earned', 'reversed') group by partner_id`;
  if (r && r.net > 0)
    await tx`insert into partner_rewards (partner_id, kind, amount_paise, invoice_id, note, user_id)
             values (${r.partner_id}, 'reversed', ${-r.net}, ${invoiceId}, ${`Bill ${number} cancelled`}, ${ctx.userId})`;
}

/** Goods returned: take back the reward on exactly the returned part of each line. */
export async function reverseRewardsOnReturn(tx: Tx, ctx: Ctx, invoiceId: number, creditNoteId: number, number: string, lines: { invoiceLineId: number; baseQtyMilli: number; lineBaseQtyMilli: number }[]) {
  const [e] = await tx<{ partner_id: number; details: Record<string, number> }[]>`
    select partner_id, details from partner_rewards where invoice_id = ${invoiceId} and kind = 'earned' limit 1`;
  if (!e) return;
  let back = 0;
  for (const l of lines) {
    const reward = e.details[String(l.invoiceLineId)] ?? 0;
    if (reward && l.lineBaseQtyMilli > 0) back += mulDivRound(reward, l.baseQtyMilli, l.lineBaseQtyMilli);
  }
  // never take back more than is still standing on the bill
  const [st] = await tx<{ net: number }[]>`select coalesce(sum(amount_paise), 0)::bigint as net from partner_rewards where invoice_id = ${invoiceId} and kind in ('earned', 'reversed')`;
  back = Math.min(back, Math.max(st!.net, 0));
  if (back > 0)
    await tx`insert into partner_rewards (partner_id, kind, amount_paise, invoice_id, credit_note_id, note, user_id)
             values (${e.partner_id}, 'reversed', ${-back}, ${invoiceId}, ${creditNoteId}, ${`Goods returned (${number})`}, ${ctx.userId})`;
}

/** Pay a partner's reward in cash/bank (posted as an expense) or record a gift redemption. */
export async function payReward(sql: Sql, ctx: Ctx, partnerId: number, input: { amountPaise: number; how: 'payout' | 'redeemed'; fromLedgerId?: number; note?: string; clientRef?: string }, opts: { fileDir?: string } = {}) {
  requirePerm(ctx, 'partners.rewards', 'Only admin can pay out rewards');
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) throw new AppError(400, 'BAD_AMOUNT', 'Enter an amount more than zero');
  const [p] = await sql<{ id: number; name: string; balance: number }[]>`
    select p.id, p.name, coalesce((select sum(amount_paise) from partner_rewards where partner_id = p.id), 0)::bigint as balance from partners p where p.id = ${partnerId}`;
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Partner not found');
  if (input.amountPaise > p.balance) throw new AppError(400, 'OVER_BALANCE', `${p.name}'s reward balance is only ₹${(p.balance / 100).toFixed(2)}`);
  let moneyEntryId: number | null = null;
  if (input.how === 'payout') {
    if (!input.fromLedgerId) throw new AppError(400, 'FROM_REQUIRED', 'Choose where the money is paid from');
    const [head] = await sql<{ id: number }[]>`select id from ledgers where system_code = 'partner_commission'`;
    const e = await createExpense(sql, ctx, {
      ledgerId: head!.id,
      fromLedgerId: input.fromLedgerId,
      amountPaise: input.amountPaise,
      narration: `Reward to ${p.name}${input.note ? ` — ${input.note}` : ''}`,
      clientRef: input.clientRef,
    }, opts);
    moneyEntryId = e.id;
  }
  const [r] = await sql<{ id: number }[]>`
    insert into partner_rewards (partner_id, kind, amount_paise, money_entry_id, note, user_id)
    values (${partnerId}, ${input.how}, ${-input.amountPaise}, ${moneyEntryId}, ${clean(input.note)}, ${ctx.userId}) returning id`;
  await audit(sql, ctx, `partner.${input.how}`, { entity: 'partner', entityId: partnerId, details: { amountPaise: input.amountPaise, moneyEntryId } });
  return { id: r!.id, moneyEntryId };
}

// ------------------------------------------------------------------ profile

export async function partnerProfile(q: Q, ctx: Ctx, id: number, r: { from: string; to: string }) {
  if (!can(ctx, 'partners.manage') && !can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see partners');
  const [p] = await listPartners(q, { includeInactive: true, from: r.from, to: r.to }).then((rows) => rows.filter((x) => x.id === id));
  if (!p) throw new AppError(404, 'NOT_FOUND', 'Partner not found');
  const bills = await q<{ id: number; number: string; invoice_date: string; customer_name: string | null; total_paise: number; status: string; payment_mode: string; site_name: string | null; returns_paise: number }[]>`
    select si.id, si.number, si.invoice_date, si.customer_name, si.total_paise, si.status, si.payment_mode, s.name as site_name,
           coalesce((select sum(total_paise) from credit_notes cn where cn.invoice_id = si.id and cn.status = 'posted'), 0)::bigint as returns_paise
    from invoice_partners ip join sales_invoices si on si.id = ip.invoice_id left join partner_sites s on s.id = ip.site_id
    where ip.partner_id = ${id} and si.invoice_date between ${r.from} and ${r.to}
    order by si.id desc limit 500`;
  // what they brought in, by category and brand (net of returns); paint also in litres
  const byCategory = await q<{ category: string; brand: string; qty: number; unit: string; litres_milli: number; amount: number }[]>`
    select coalesce(c.name, 'Other') as category, coalesce(b.name, '—') as brand, sum(x.qty)::bigint as qty, min(p.unit_code) as unit,
           sum(round(x.qty::numeric * coalesce(p.contents_milli, 0) / 1000))::bigint as litres_milli, sum(x.amount)::bigint as amount
    from (
      select l.product_id, l.base_qty_milli as qty, l.taxable_paise as amount
      from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id join invoice_partners ip on ip.invoice_id = si.id
      where ip.partner_id = ${id} and si.status = 'posted' and si.invoice_date between ${r.from} and ${r.to}
      union all
      select cl.product_id, -cl.base_qty_milli, -cl.taxable_paise
      from credit_note_lines cl join credit_notes cn on cn.id = cl.credit_note_id join invoice_partners ip on ip.invoice_id = cn.invoice_id
      where ip.partner_id = ${id} and cn.status = 'posted' and cn.note_date between ${r.from} and ${r.to}
    ) x join products p on p.id = x.product_id left join categories c on c.id = p.category_id left join brands b on b.id = p.brand_id
    group by 1, 2 having sum(x.qty) <> 0
    order by sum(x.amount) desc`;
  const sites = await q`
    select s.id, s.name, s.address, s.owner_name, s.active, count(ip.invoice_id)::int as bills,
           coalesce(sum(si.total_paise) filter (where si.status = 'posted'), 0)::bigint as sales_paise
    from partner_sites s left join invoice_partners ip on ip.site_id = s.id left join sales_invoices si on si.id = ip.invoice_id
    where s.partner_id = ${id} group by s.id order by s.active desc, s.id desc`;
  const notes = await q`
    select n.id, n.at, n.note, n.invoice_id, si.number as invoice_number, n.site_id, s.name as site_name, u.name as user_name
    from partner_notes n join users u on u.id = n.user_id left join sales_invoices si on si.id = n.invoice_id left join partner_sites s on s.id = n.site_id
    where n.partner_id = ${id} order by n.id desc limit 300`;
  const rewards = await q`
    select r.id, r.at, r.kind, r.amount_paise, r.note, r.invoice_id, si.number as invoice_number, m.number as entry_number, u.name as user_name
    from partner_rewards r join users u on u.id = r.user_id left join sales_invoices si on si.id = r.invoice_id left join money_entries m on m.id = r.money_entry_id
    where r.partner_id = ${id} order by r.id desc limit 300`;
  const shades = await listShades(q, { partnerId: id });
  let credit: { balancePaise: number; customerName: string } | null = null;
  if (p.customer_id) {
    const [c] = await q<{ name: string; bal: number }[]>`
      select c.name, l.opening_dr_paise + coalesce((select sum(dr_paise - cr_paise) from voucher_lines where ledger_id = l.id), 0) as bal
      from customers c join ledgers l on l.id = c.ledger_id where c.id = ${p.customer_id}`;
    if (c) credit = { balancePaise: c.bal, customerName: c.name };
  }
  const posted = bills.filter((b) => b.status === 'posted');
  return {
    partner: p,
    ...r,
    totals: { bills: posted.length, salesPaise: posted.reduce((t, b) => t + b.total_paise, 0), returnsPaise: posted.reduce((t, b) => t + b.returns_paise, 0) },
    bills,
    byCategory,
    sites,
    notes,
    rewards,
    rewardBalancePaise: p.reward_balance_paise,
    shades,
    credit,
  };
}

// ------------------------------------------------------------------ sites, notes, shades

export async function addSite(sql: Sql, ctx: Ctx, partnerId: number, input: { name: string; address?: string; ownerName?: string }) {
  requirePerm(ctx, 'partners.manage');
  const name = clean(input.name);
  if (!name) throw new AppError(400, 'NAME_REQUIRED', 'Give the site a name, e.g. "Reddy house, Musunuru"');
  const [s] = await sql<{ id: number }[]>`
    insert into partner_sites (partner_id, name, address, owner_name) values (${partnerId}, ${name}, ${clean(input.address)}, ${clean(input.ownerName)}) returning id`;
  return { id: s!.id };
}

export async function updateSite(sql: Sql, ctx: Ctx, siteId: number, input: { name?: string; address?: string | null; ownerName?: string | null; active?: boolean }) {
  requirePerm(ctx, 'partners.manage');
  await sql`update partner_sites set name = coalesce(${clean(input.name)}, name), address = coalesce(${input.address === undefined ? null : clean(input.address)}, address),
            owner_name = coalesce(${input.ownerName === undefined ? null : clean(input.ownerName)}, owner_name), active = coalesce(${input.active ?? null}, active) where id = ${siteId}`;
  return { id: siteId };
}

export async function addNote(sql: Sql, ctx: Ctx, partnerId: number, input: { note: string; invoiceId?: number | null; siteId?: number | null }) {
  requirePerm(ctx, 'partners.manage');
  const note = clean(input.note);
  if (!note) throw new AppError(400, 'NOTE_REQUIRED', 'Write the note');
  if (input.invoiceId) {
    const [t] = await sql`select 1 from invoice_partners where invoice_id = ${input.invoiceId} and partner_id = ${partnerId}`;
    if (!t) throw new AppError(400, 'BAD_BILL', 'That bill is not linked to this partner');
  }
  const [n] = await sql<{ id: number }[]>`
    insert into partner_notes (partner_id, invoice_id, site_id, note, user_id) values (${partnerId}, ${input.invoiceId ?? null}, ${input.siteId ?? null}, ${note}, ${ctx.userId}) returning id`;
  return { id: n!.id };
}

export interface ShadeInput {
  partnerId?: number | null;
  customerId?: number | null;
  siteId?: number | null;
  productId?: number | null;
  base?: string;
  tint?: string;
  shadeCode?: string;
  shadeName?: string;
  quantity?: string;
  shadeDate?: string;
  note?: string;
}

export async function addShade(sql: Sql, ctx: Ctx, input: ShadeInput) {
  if (!can(ctx, 'partners.manage') && !can(ctx, 'customers.manage')) throw new AppError(403, 'FORBIDDEN', 'You are not allowed to save shades');
  if (!input.partnerId && !input.customerId) throw new AppError(400, 'WHO', 'Choose the partner or customer');
  if (!clean(input.shadeCode) && !clean(input.shadeName)) throw new AppError(400, 'SHADE_REQUIRED', 'Enter the shade code or name');
  const [s] = await sql<{ id: number }[]>`
    insert into paint_shades (partner_id, customer_id, site_id, product_id, base, tint, shade_code, shade_name, quantity, shade_date, note, user_id)
    values (${input.partnerId ?? null}, ${input.customerId ?? null}, ${input.siteId ?? null}, ${input.productId ?? null}, ${clean(input.base)}, ${clean(input.tint)},
            ${clean(input.shadeCode)}, ${clean(input.shadeName)}, ${clean(input.quantity)}, ${input.shadeDate ?? istDate()}, ${clean(input.note)}, ${ctx.userId})
    returning id`;
  return { id: s!.id };
}

export async function listShades(q: Q, f: { partnerId?: number; customerId?: number; search?: string }) {
  const search = f.search?.trim() ? `%${f.search.trim().toLowerCase()}%` : null;
  return q`
    select s.id, s.partner_id, pa.name as partner_name, s.customer_id, c.name as customer_name, s.site_id, si.name as site_name,
           s.product_id, p.name as product_name, s.base, s.tint, s.shade_code, s.shade_name, s.quantity, s.shade_date, s.note, u.name as user_name
    from paint_shades s join users u on u.id = s.user_id left join partners pa on pa.id = s.partner_id left join customers c on c.id = s.customer_id
         left join partner_sites si on si.id = s.site_id left join products p on p.id = s.product_id
    where (${f.partnerId ?? null}::int is null or s.partner_id = ${f.partnerId ?? null})
      and (${f.customerId ?? null}::int is null or s.customer_id = ${f.customerId ?? null})
      and (${search}::text is null or lower(coalesce(s.shade_code, '') || ' ' || coalesce(s.shade_name, '') || ' ' || coalesce(pa.name, '') || ' ' || coalesce(c.name, '')) like ${search})
    order by s.shade_date desc, s.id desc limit 500`;
}

// ------------------------------------------------------------------ reports

/** Top partners in a period, and partners who have gone quiet (no bill for 30/60/90+ days). */
export async function partnerReport(q: Q, ctx: Ctx, r: { from: string; to: string }) {
  if (!can(ctx, 'partners.manage') && !can(ctx, 'reports.view')) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to see partners');
  const all = await listPartners(q, { from: r.from, to: r.to });
  const top = all.filter((p) => p.bills > 0).slice(0, 20);
  const inactive = all
    .filter((p) => p.days_since == null || p.days_since >= 30)
    .map((p) => ({ ...p, bucket: p.days_since == null ? 'never' : p.days_since >= 90 ? '90+' : p.days_since >= 60 ? '60–89' : '30–59' }))
    .sort((a, b) => (b.days_since ?? 99999) - (a.days_since ?? 99999));
  const byCategory = await q<{ partner_id: number; partner: string; category: string; amount: number }[]>`
    select ip.partner_id, pa.name as partner, coalesce(c.name, 'Other') as category, sum(l.taxable_paise)::bigint as amount
    from sales_invoice_lines l join sales_invoices si on si.id = l.invoice_id join invoice_partners ip on ip.invoice_id = si.id
         join partners pa on pa.id = ip.partner_id join products p on p.id = l.product_id left join categories c on c.id = p.category_id
    where si.status = 'posted' and si.invoice_date between ${r.from} and ${r.to}
    group by 1, 2, 3 order by 2, 4 desc`;
  return { ...r, top, inactive, byCategory };
}
