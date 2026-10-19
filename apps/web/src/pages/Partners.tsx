import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, formatQty, parseRupees } from '@kph/core';
import { ApiError, download, get, patch, post, put, qs } from '../lib/api';
import { fmtDate, fmtDateTime, todayIst, uuid } from '../lib/format';
import { useSession } from '../lib/session';
import type { ProductRow } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, cx, useDebounced, useToast } from '../components/ui';
import type { PartnerRow } from '../components/PartnerBits';
import { InvoiceModal } from './Sales';

/**
 * Trade partners (painters, masons, contractors…): kept apart from customers. Tag them on bills;
 * see what they bring in, their sites, notes, rewards and paint shades.
 */

const money = (p: number) => `₹${formatPaise(p)}`;
const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

interface PartnerType {
  id: number;
  name: string;
  active: boolean;
  partners: number;
  rules: { id: number; category_id: number | null; category_name: string | null; mode: 'percent' | 'per_unit'; value: number }[];
}

type Tab = 'all' | 'top' | 'inactive' | 'shades' | 'types';

export function Partners() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'all';
  const [search, setSearch] = useState('');
  const [typeId, setTypeId] = useState<number | ''>('');
  const s = useDebounced(search);
  const types = useQuery({ queryKey: ['partners', 'types'], queryFn: () => get<PartnerType[]>('/api/partner-types') });
  const list = useQuery({ queryKey: ['partners', 'list', s, typeId], queryFn: () => get<PartnerRow[]>(`/api/partners${qs({ search: s, typeId: typeId || undefined })}`), enabled: tab === 'all' });
  const [editing, setEditing] = useState<PartnerRow | 'new' | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  const TABS: [Tab, string][] = [
    ['all', 'All partners'],
    ['top', 'Top this month'],
    ['inactive', 'Gone quiet'],
    ['shades', 'Paint shades'],
    ...(can('partners.rewards') ? ([['types', 'Types & rewards']] as [Tab, string][]) : []),
  ];

  return (
    <Page wide>
      <PageTitle
        telugu="భాగస్వాములు"
        title="Partners"
        sub="Painters, masons, contractors and others who bring customers — kept separate from customers."
        actions={
          can('partners.manage') && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              + Add partner
            </Button>
          )
        }
      />
      <nav aria-label="Partners" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setParams({ tab: id })} className={cx('h-11 px-3 text-sm', tab === id ? 'font-bold text-ink shadow-[inset_0_-3px_0_#c2491a]' : 'text-ink-3 hover:text-ink')}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'all' && (
        <>
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Search name, phone or area…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[320px]" />
            <Select value={typeId} onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : '')} className="max-w-[200px]">
              <option value="">All types</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.partners})
                </option>
              ))}
            </Select>
          </div>
          <section className="overflow-hidden rounded-[6px] border border-line bg-white">
            {list.isLoading ? (
              <div className="p-4"><Spinner /></div>
            ) : (list.data ?? []).length ? (
              <Table head={<tr><th>Partner</th><th>Type</th><th>Area</th><th className="text-right">Bills this month</th><th className="text-right">Sales this month</th><th>Last bill</th><th className="text-right">Reward due</th></tr>}>
                {list.data!.map((p) => (
                  <tr key={p.id} className="cursor-pointer hover:bg-paper" onClick={() => setOpenId(p.id)}>
                    <td>
                      <span className="font-semibold">{p.name}</span>
                      <span className="block text-[12px] text-ink-3">{p.phone ?? 'no phone'}</span>
                    </td>
                    <td>{p.type_name}</td>
                    <td className="text-ink-3">{p.area}</td>
                    <td className="num text-right">{p.bills || '—'}</td>
                    <td className="num text-right font-bold">{p.sales_paise ? money(p.sales_paise) : '—'}</td>
                    <td className="num">{p.last_bill ? `${fmtDate(p.last_bill)} (${p.days_since} d)` : <span className="text-ink-3">never</span>}</td>
                    <td className="num text-right">{p.reward_balance_paise ? money(p.reward_balance_paise) : '—'}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>No partners yet. Add your painters and masons with “+ Add partner”.</Empty>
            )}
          </section>
        </>
      )}
      {(tab === 'top' || tab === 'inactive') && <PartnerReports tab={tab} onOpen={setOpenId} />}
      {tab === 'shades' && <AllShades />}
      {tab === 'types' && <TypesAndRewards types={types.data ?? []} />}

      <PartnerForm open={editing != null} partner={editing === 'new' ? null : editing} types={types.data ?? []} onClose={() => setEditing(null)} />
      <PartnerDetail id={openId} onClose={() => setOpenId(null)} onEdit={(p) => (setOpenId(null), setEditing(p))} />
    </Page>
  );
}

// ------------------------------------------------------------------ add / edit

function PartnerForm({ open, partner, types, onClose }: { open: boolean; partner: PartnerRow | null; types: PartnerType[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF({
      name: partner?.name ?? '',
      phone: partner?.phone ?? '',
      area: partner?.area ?? '',
      typeId: String(partner?.type_id ?? types.find((t) => t.active)?.id ?? ''),
      notes: partner?.notes ?? '',
      joinedOn: partner?.joined_on ?? todayIst(),
      language: partner?.language ?? '',
      active: partner?.active === false ? '' : '1',
    });
  }, [open, partner, types]);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: f.name, phone: f.phone || null, area: f.area || null, typeId: Number(f.typeId), notes: f.notes || null, joinedOn: f.joinedOn, language: f.language || null, ...(partner ? { active: f.active === '1' } : {}) };
      if (partner) await patch(`/api/partners/${partner.id}`, body);
      else await post('/api/partners', body);
      toast({ tone: 'good', text: `Saved ${f.name}` });
      void qc.invalidateQueries({ queryKey: ['partners'] });
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={partner ? 'Edit partner' : 'Add partner'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="dark" busy={busy} disabled={(f.name ?? '').trim().length < 2 || !f.typeId} onClick={() => void save()}>Save partner</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          <Input value={f.name ?? ''} onChange={set('name')} autoFocus />
        </Field>
        <Field label="Type">
          <Select value={f.typeId ?? ''} onChange={set('typeId')}>
            {types.filter((t) => t.active || String(t.id) === f.typeId).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Phone">
          <Input value={f.phone ?? ''} onChange={set('phone')} inputMode="tel" />
        </Field>
        <Field label="Area / village">
          <Input value={f.area ?? ''} onChange={set('area')} />
        </Field>
        <Field label="Joined on">
          <Input type="date" value={f.joinedOn ?? ''} onChange={set('joinedOn')} />
        </Field>
        <Field label="Message language">
          <Select value={f.language ?? ''} onChange={set('language')}>
            <option value="">Shop default</option>
            <option value="te">Telugu</option>
            <option value="en">English</option>
          </Select>
        </Field>
        {partner && (
          <Field label="Status">
            <Select value={f.active ?? '1'} onChange={set('active')}>
              <option value="1">Active</option>
              <option value="">Not active</option>
            </Select>
          </Field>
        )}
        <Field label="Notes" className="sm:col-span-2">
          <Input value={f.notes ?? ''} onChange={set('notes')} />
        </Field>
        {error && <div className="sm:col-span-2"><Notice tone="bad">{error}</Notice></div>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ profile

interface Profile {
  partner: PartnerRow;
  from: string;
  to: string;
  totals: { bills: number; salesPaise: number; returnsPaise: number };
  bills: { id: number; number: string; invoice_date: string; customer_name: string | null; total_paise: number; status: string; payment_mode: string; site_name: string | null; returns_paise: number }[];
  byCategory: { category: string; brand: string; qty: number; unit: string; litres_milli: number; amount: number }[];
  sites: { id: number; name: string; address: string | null; owner_name: string | null; active: boolean; bills: number; sales_paise: number }[];
  notes: { id: number; at: string; note: string; invoice_number: string | null; site_name: string | null; user_name: string }[];
  rewards: { id: number; at: string; kind: string; amount_paise: number; note: string | null; invoice_number: string | null; entry_number: string | null; user_name: string }[];
  rewardBalancePaise: number;
  shades: Shade[];
  credit: { balancePaise: number; customerName: string } | null;
}

interface Shade {
  id: number;
  partner_name: string | null;
  customer_name: string | null;
  site_name: string | null;
  product_name: string | null;
  base: string | null;
  tint: string | null;
  shade_code: string | null;
  shade_name: string | null;
  quantity: string | null;
  shade_date: string;
  note: string | null;
}

function PartnerDetail({ id, onClose, onEdit }: { id: number | null; onClose: () => void; onEdit: (p: PartnerRow) => void }) {
  const { can } = useSession();
  const [from, setFrom] = useState(`${todayIst().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(todayIst());
  const q = useQuery({ queryKey: ['partners', 'profile', id, from, to], queryFn: () => get<Profile>(`/api/partners/${id}?from=${from}&to=${to}`), enabled: id != null });
  const [tab, setTab] = useState<'summary' | 'bills' | 'notes' | 'sites' | 'rewards' | 'shades'>('summary');
  const [invoiceId, setInvoiceId] = useState<number | null>(null);
  useEffect(() => setTab('summary'), [id]);
  const d = q.data;
  return (
    <>
      <Modal
        open={id != null && invoiceId == null}
        onClose={onClose}
        title={d ? `${d.partner.name} · ${d.partner.type_name}` : 'Partner'}
        width={960}
        footer={d && can('partners.manage') && <Button onClick={() => onEdit(d.partner)}>Edit details</Button>}
      >
        {!d ? (
          <Spinner />
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-end gap-2">
              <span className="text-ink-3">{[d.partner.phone, d.partner.area, `since ${fmtDate(d.partner.joined_on)}`].filter(Boolean).join(' · ')}</span>
              <span className="ml-auto flex items-end gap-2">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-[145px]" aria-label="From" />
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-[145px]" aria-label="To" />
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat k="Bills brought" v={String(d.totals.bills)} />
              <Stat k="Sales" v={money(d.totals.salesPaise - d.totals.returnsPaise)} />
              <Stat k="Reward due" v={money(d.rewardBalancePaise)} />
              <Stat k={d.credit ? `Owes (as ${d.credit.customerName})` : 'Own credit'} v={d.credit ? money(d.credit.balancePaise) : '—'} />
            </div>
            <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
              {(
                [
                  ['summary', 'What they bring'],
                  ['bills', `Bills (${d.bills.length})`],
                  ['notes', `Notes (${d.notes.length})`],
                  ['sites', `Sites (${d.sites.length})`],
                  ['rewards', 'Rewards'],
                  ['shades', `Shades (${d.shades.length})`],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx('-mb-px h-10 px-3 text-sm', tab === k ? 'border-b-[3px] border-brick font-bold' : 'text-ink-3')}>
                  {label}
                </button>
              ))}
            </div>
            {tab === 'summary' &&
              (d.byCategory.length ? (
                <Table minWidth={560} head={<tr><th>Category</th><th>Brand</th><th className="text-right">Quantity</th><th className="text-right">Amount (before GST)</th></tr>}>
                  {d.byCategory.map((c, i) => (
                    <tr key={i}>
                      <td>{c.category}</td>
                      <td>{c.brand}</td>
                      <td className="num text-right">
                        {formatQty(c.qty)} {c.unit}
                        {c.litres_milli > 0 && <span className="block text-[12px] text-ink-3">{formatQty(c.litres_milli)} litres</span>}
                      </td>
                      <td className="num text-right font-bold">{money(c.amount)}</td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <Empty>No bills in this period.</Empty>
              ))}
            {tab === 'bills' &&
              (d.bills.length ? (
                <Table minWidth={620} head={<tr><th>Bill</th><th>Date</th><th>Customer</th><th>Site</th><th className="text-right">Total</th></tr>}>
                  {d.bills.map((b) => (
                    <tr key={b.id} className="cursor-pointer hover:bg-paper" onClick={() => setInvoiceId(b.id)}>
                      <td className="num font-semibold">
                        {b.number} {b.status === 'cancelled' && <Badge tone="bad">Cancelled</Badge>}
                      </td>
                      <td className="num">{fmtDate(b.invoice_date)}</td>
                      <td>{b.customer_name ?? 'Walk-in'}</td>
                      <td className="text-ink-3">{b.site_name}</td>
                      <td className="num text-right font-bold">
                        {money(b.total_paise)}
                        {b.returns_paise > 0 && <span className="block text-[12px] font-normal text-ink-3">returned {money(b.returns_paise)}</span>}
                      </td>
                    </tr>
                  ))}
                </Table>
              ) : (
                <Empty>No bills in this period. Tag this partner when billing (“Brought by”).</Empty>
              ))}
            {tab === 'notes' && <NotesTab partnerId={d.partner.id} notes={d.notes} bills={d.bills} sites={d.sites} />}
            {tab === 'sites' && <SitesTab partnerId={d.partner.id} sites={d.sites} />}
            {tab === 'rewards' && <RewardsTab partnerId={d.partner.id} balance={d.rewardBalancePaise} rewards={d.rewards} />}
            {tab === 'shades' && <ShadesTab partnerId={d.partner.id} shades={d.shades} sites={d.sites} />}
          </div>
        )}
      </Modal>
      <InvoiceModal id={invoiceId} onClose={() => setInvoiceId(null)} />
    </>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-[4px] bg-concrete px-3 py-2">
      <div className="text-[11px]">{k}</div>
      <div className="num text-base font-extrabold">{v}</div>
    </div>
  );
}

function useRefresh() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['partners'] });
}

function NotesTab({ partnerId, notes, bills, sites }: { partnerId: number; notes: Profile['notes']; bills: Profile['bills']; sites: Profile['sites'] }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [note, setNote] = useState('');
  const [invoiceId, setInvoiceId] = useState<number | ''>('');
  const [siteId, setSiteId] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await post(`/api/partners/${partnerId}/notes`, { note, invoiceId: invoiceId || null, siteId: siteId || null });
      setNote('');
      refresh();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_180px_180px_auto]">
        <Input placeholder="e.g. Bought 20L Birla Opus exterior for Reddy's house, shade XYZ" value={note} onChange={(e) => setNote(e.target.value)} />
        <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value ? Number(e.target.value) : '')} aria-label="About a bill">
          <option value="">About a bill…</option>
          {bills.map((b) => (
            <option key={b.id} value={b.id}>
              {b.number}
            </option>
          ))}
        </Select>
        <Select value={siteId} onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : '')} aria-label="About a site">
          <option value="">About a site…</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Button variant="primary" busy={busy} disabled={!note.trim()} onClick={() => void save()}>
          Add note
        </Button>
      </div>
      {notes.length ? (
        <ol className="relative flex flex-col gap-3 border-l-2 border-line pl-4">
          {notes.map((n) => (
            <li key={n.id} className="relative">
              <span className="absolute -left-[23px] top-1 size-3 rounded-full border-2 border-white bg-brick" />
              <div className="text-[12px] text-ink-3">
                {fmtDateTime(n.at)} · {n.user_name}
                {n.invoice_number && <> · bill {n.invoice_number}</>}
                {n.site_name && <> · {n.site_name}</>}
              </div>
              <div>{n.note}</div>
            </li>
          ))}
        </ol>
      ) : (
        <Empty>No notes yet.</Empty>
      )}
    </div>
  );
}

function SitesTab({ partnerId, sites }: { partnerId: number; sites: Profile['sites'] }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [f, setF] = useState({ name: '', address: '', ownerName: '' });
  const add = async () => {
    try {
      await post(`/api/partners/${partnerId}/sites`, f);
      setF({ name: '', address: '', ownerName: '' });
      refresh();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  const toggle = async (s: Profile['sites'][number]) => {
    await patch(`/api/partner-sites/${s.id}`, { active: !s.active }).catch((e) => toast({ tone: 'bad', text: errText(e) }));
    refresh();
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
        <Input placeholder="Site name, e.g. Reddy house" value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} />
        <Input placeholder="Address" value={f.address} onChange={(e) => setF((x) => ({ ...x, address: e.target.value }))} />
        <Input placeholder="House owner" value={f.ownerName} onChange={(e) => setF((x) => ({ ...x, ownerName: e.target.value }))} />
        <Button variant="primary" disabled={!f.name.trim()} onClick={() => void add()}>
          Add site
        </Button>
      </div>
      {sites.length ? (
        <Table minWidth={560} head={<tr><th>Site</th><th>Owner</th><th className="text-right">Bills</th><th className="text-right">Sales</th><th /></tr>}>
          {sites.map((s) => (
            <tr key={s.id} className={s.active ? '' : 'text-ink-3'}>
              <td>
                <b>{s.name}</b>
                {s.address && <span className="block text-[12px] text-ink-3">{s.address}</span>}
              </td>
              <td>{s.owner_name}</td>
              <td className="num text-right">{s.bills}</td>
              <td className="num text-right font-bold">{money(s.sales_paise)}</td>
              <td className="text-right">
                <Button size="sm" variant="ghost" onClick={() => void toggle(s)}>
                  {s.active ? 'Finished' : 'Reopen'}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>No sites yet. Add a site to group this partner’s purchases by house / project.</Empty>
      )}
    </div>
  );
}

const KIND: Record<string, string> = { earned: 'Earned', reversed: 'Taken back', payout: 'Paid out', redeemed: 'Gift / redeemed', adjustment: 'Adjustment' };

function RewardsTab({ partnerId, balance, rewards }: { partnerId: number; balance: number; rewards: Profile['rewards'] }) {
  const { can } = useSession();
  const toast = useToast();
  const refresh = useRefresh();
  const money2 = useQuery({ queryKey: ['accounts', 'money-ledgers-partner'], queryFn: async () => [...(await get<{ id: number; name: string }[]>('/api/ledgers?kind=cash')), ...(await get<{ id: number; name: string }[]>('/api/ledgers?kind=bank'))], enabled: can('partners.rewards') });
  const [amount, setAmount] = useState('');
  const [how, setHow] = useState<'payout' | 'redeemed'>('payout');
  const [from, setFrom] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    setBusy(true);
    try {
      await post(`/api/partners/${partnerId}/rewards`, { amountPaise: parseRupees(amount), how, fromLedgerId: how === 'payout' ? from || undefined : undefined, note: note || undefined, clientRef: uuid() });
      setAmount('');
      setNote('');
      toast({ tone: 'good', text: how === 'payout' ? 'Reward paid — booked as Partner Commission' : 'Gift recorded' });
      refresh();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="teal">Reward due: <b className="num">{money(balance)}</b>. Rewards are earned on tagged bills (rules in Types &amp; rewards) and taken back when goods are returned or a bill is cancelled.</Notice>
      {can('partners.rewards') && balance > 0 && (
        <div className="grid gap-2 sm:grid-cols-[130px_150px_170px_1fr_auto]">
          <Input placeholder="₹ amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Select value={how} onChange={(e) => setHow(e.target.value as typeof how)}>
            <option value="payout">Pay cash / bank</option>
            <option value="redeemed">Give a gift</option>
          </Select>
          {how === 'payout' ? (
            <Select value={from} onChange={(e) => setFrom(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Paid from…</option>
              {(money2.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          ) : (
            <span />
          )}
          <Input placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button variant="primary" busy={busy} disabled={!parseRupees(amount) || (how === 'payout' && !from)} onClick={() => void pay()}>
            Save
          </Button>
        </div>
      )}
      {rewards.length ? (
        <Table minWidth={560} head={<tr><th>When</th><th>What</th><th>Details</th><th className="text-right">Amount</th></tr>}>
          {rewards.map((r) => (
            <tr key={r.id}>
              <td className="num">{fmtDateTime(r.at)}</td>
              <td>{KIND[r.kind] ?? r.kind}</td>
              <td className="text-ink-3">{[r.invoice_number, r.entry_number, r.note].filter(Boolean).join(' · ')}</td>
              <td className={cx('num text-right font-bold', r.amount_paise < 0 && 'text-bad')}>{r.amount_paise < 0 ? `− ${money(-r.amount_paise)}` : money(r.amount_paise)}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>No rewards yet.</Empty>
      )}
    </div>
  );
}

function ShadeForm({ partnerId, sites, onSaved }: { partnerId: number; sites: Profile['sites']; onSaved: () => void }) {
  const toast = useToast();
  const products = useQuery({ queryKey: ['products', 'billing'], queryFn: () => get<ProductRow[]>('/api/products') });
  const [f, setF] = useState({ productId: '', siteId: '', base: '', tint: '', shadeCode: '', shadeName: '', quantity: '', note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    try {
      await post('/api/shades', { partnerId, productId: f.productId ? Number(f.productId) : null, siteId: f.siteId ? Number(f.siteId) : null, base: f.base, tint: f.tint, shadeCode: f.shadeCode, shadeName: f.shadeName, quantity: f.quantity, note: f.note });
      setF({ productId: '', siteId: '', base: '', tint: '', shadeCode: '', shadeName: '', quantity: '', note: '' });
      onSaved();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  return (
    <div className="grid gap-2 rounded-[6px] bg-paper p-3 sm:grid-cols-4">
      <Select value={f.productId} onChange={set('productId')} aria-label="Paint" className="sm:col-span-2">
        <option value="">Paint (optional)…</option>
        {(products.data ?? []).filter((p) => p.contents_milli).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <Input placeholder="Shade code, e.g. 7034" value={f.shadeCode} onChange={set('shadeCode')} />
      <Input placeholder="Shade name" value={f.shadeName} onChange={set('shadeName')} />
      <Input placeholder="Base" value={f.base} onChange={set('base')} />
      <Input placeholder="Tint / formula" value={f.tint} onChange={set('tint')} className="sm:col-span-2" />
      <Input placeholder="Quantity, e.g. 20 L" value={f.quantity} onChange={set('quantity')} />
      <Select value={f.siteId} onChange={set('siteId')} aria-label="Site">
        <option value="">Site (optional)…</option>
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <Input placeholder="Note" value={f.note} onChange={set('note')} className="sm:col-span-2" />
      <Button variant="primary" disabled={!f.shadeCode.trim() && !f.shadeName.trim()} onClick={() => void save()}>
        Save shade
      </Button>
    </div>
  );
}

function ShadeTable({ shades, who }: { shades: Shade[]; who?: boolean }) {
  if (!shades.length) return <Empty>No shades saved yet.</Empty>;
  return (
    <Table head={<tr><th>Date</th>{who && <th>For</th>}<th>Shade</th><th>Paint / base</th><th>Tint</th><th>Qty</th><th>Site / note</th></tr>}>
      {shades.map((s) => (
        <tr key={s.id}>
          <td className="num">{fmtDate(s.shade_date)}</td>
          {who && <td>{s.partner_name ?? s.customer_name}</td>}
          <td>
            <b className="num">{s.shade_code}</b> {s.shade_name}
          </td>
          <td>{[s.product_name, s.base].filter(Boolean).join(' · ')}</td>
          <td className="text-ink-3">{s.tint}</td>
          <td>{s.quantity}</td>
          <td className="text-ink-3">{[s.site_name, s.note].filter(Boolean).join(' · ')}</td>
        </tr>
      ))}
    </Table>
  );
}

function ShadesTab({ partnerId, shades, sites }: { partnerId: number; shades: Shade[]; sites: Profile['sites'] }) {
  const refresh = useRefresh();
  return (
    <div className="flex flex-col gap-3">
      <ShadeForm partnerId={partnerId} sites={sites} onSaved={refresh} />
      <ShadeTable shades={shades} />
    </div>
  );
}

function AllShades() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = useQuery({ queryKey: ['partners', 'shades', dq], queryFn: () => get<Shade[]>(`/api/shades${qs({ search: dq })}`) });
  return (
    <div className="flex flex-col gap-3">
      <Input placeholder="Search shade code, name, partner or customer…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-[360px]" />
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">{list.data ? <ShadeTable shades={list.data} who /> : <div className="p-4"><Spinner /></div>}</section>
      <p className="text-[12px] text-ink-3">Shades are saved from a partner’s page (Shades tab), so repeat orders match exactly.</p>
    </div>
  );
}

// ------------------------------------------------------------------ reports

function PartnerReports({ tab, onOpen }: { tab: 'top' | 'inactive'; onOpen: (id: number) => void }) {
  const toast = useToast();
  const from = `${todayIst().slice(0, 8)}01`;
  const to = todayIst();
  const d = useQuery({ queryKey: ['partners', 'report', from, to], queryFn: () => get<{ top: PartnerRow[]; inactive: (PartnerRow & { bucket: string })[] }>(`/api/reports/partners?from=${from}&to=${to}`) });
  if (!d.data) return <Spinner />;
  const rows: ReactNode =
    tab === 'top' ? (
      d.data.top.length ? (
        <Table head={<tr><th>#</th><th>Partner</th><th>Type</th><th className="text-right">Bills</th><th className="text-right">Sales this month</th><th className="text-right">Reward due</th></tr>}>
          {d.data.top.map((p, i) => (
            <tr key={p.id} className="cursor-pointer hover:bg-paper" onClick={() => onOpen(p.id)}>
              <td className="num text-ink-3">{i + 1}</td>
              <td className="font-semibold">{p.name}</td>
              <td>{p.type_name}</td>
              <td className="num text-right">{p.bills}</td>
              <td className="num text-right font-bold">{money(p.sales_paise)}</td>
              <td className="num text-right">{money(p.reward_balance_paise)}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>No partner bills this month yet.</Empty>
      )
    ) : d.data.inactive.length ? (
      <Table head={<tr><th>Partner</th><th>Type</th><th>Phone</th><th>Last bill</th><th>Quiet for</th></tr>}>
        {d.data.inactive.map((p) => (
          <tr key={p.id} className="cursor-pointer hover:bg-paper" onClick={() => onOpen(p.id)}>
            <td className="font-semibold">{p.name}</td>
            <td>{p.type_name}</td>
            <td className="num">{p.phone ?? '—'}</td>
            <td className="num">{p.last_bill ? fmtDate(p.last_bill) : 'never'}</td>
            <td>
              <Badge tone={p.bucket === '90+' || p.bucket === 'never' ? 'bad' : 'warn'}>{p.bucket === 'never' ? 'no bills yet' : `${p.bucket} days`}</Badge>
            </td>
          </tr>
        ))}
      </Table>
    ) : (
      <Empty>Every partner has brought a bill in the last 30 days.</Empty>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => download(`/api/reports/partners?from=${from}&to=${to}&format=xlsx`, 'partners.xlsx').catch((e) => toast({ tone: 'bad', text: errText(e) }))}>
          Download Excel
        </Button>
      </div>
      <section className="overflow-hidden rounded-[6px] border border-line bg-white">{rows}</section>
      {tab === 'inactive' && <p className="text-[12px] text-ink-3">Partners with no bill for 30 days or more — worth a call.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ types & rewards (admin)

function TypesAndRewards({ types }: { types: PartnerType[] }) {
  const toast = useToast();
  const refresh = useRefresh();
  const cats = useQuery({ queryKey: ['categories'], queryFn: () => get<{ id: number; name: string }[]>('/api/categories') });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [rules, setRules] = useState<{ categoryId: number | null; mode: 'percent' | 'per_unit'; value: string }[]>([]);

  const startEdit = (t: PartnerType) => {
    setEditing(t.id);
    setRules(t.rules.map((r) => ({ categoryId: r.category_id, mode: r.mode, value: r.mode === 'percent' ? (r.value / 100).toString() : (r.value / 100).toFixed(2) })));
  };
  const saveRules = async () => {
    try {
      await put(`/api/partner-types/${editing}/rules`, {
        rules: rules.map((r) => ({ categoryId: r.categoryId, mode: r.mode, value: r.mode === 'percent' ? Math.round(Number(r.value) * 100) : (parseRupees(r.value) ?? 0) })),
      });
      setEditing(null);
      refresh();
      toast({ tone: 'good', text: 'Reward rules saved. They apply to bills tagged from now on.' });
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };
  const addType = async () => {
    try {
      await post('/api/partner-types', { name });
      setName('');
      refresh();
    } catch (e) {
      toast({ tone: 'bad', text: errText(e) });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Notice tone="teal">Rewards are in rupees. For each partner type, give a % of the bill (before GST) and/or an amount per unit (per bag, per litre bucket…) for a category. A category rule beats the general rule.</Notice>
      {types.map((t) => (
        <section key={t.id} className="rounded-[6px] border border-line bg-white p-3">
          <div className="flex items-center gap-2">
            <b className="flex-1">
              {t.name} <span className="font-normal text-ink-3">· {t.partners} partners</span>
            </b>
            {editing !== t.id && (
              <Button size="sm" onClick={() => startEdit(t)}>
                Edit rewards
              </Button>
            )}
          </div>
          {editing === t.id ? (
            <div className="mt-2 flex flex-col gap-2">
              {rules.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_160px_120px_auto] gap-2">
                  <Select value={r.categoryId ?? ''} onChange={(e) => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, categoryId: e.target.value ? Number(e.target.value) : null } : x)))}>
                    <option value="">All other items</option>
                    {(cats.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  <Select value={r.mode} onChange={(e) => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, mode: e.target.value as 'percent' | 'per_unit' } : x)))}>
                    <option value="percent">% of bill</option>
                    <option value="per_unit">₹ per unit</option>
                  </Select>
                  <Input inputMode="decimal" value={r.value} onChange={(e) => setRules((rs) => rs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={r.mode === 'percent' ? '%' : '₹'} />
                  <Button size="sm" variant="ghost" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setRules((rs) => [...rs, { categoryId: null, mode: 'percent', value: '' }])}>
                  + Rule
                </Button>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" onClick={() => void saveRules()}>
                  Save rewards
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-1 text-[13px] text-ink-3">
              {t.rules.length
                ? t.rules.map((r) => `${r.category_name ?? 'All other items'}: ${r.mode === 'percent' ? `${r.value / 100}% of bill` : `₹${(r.value / 100).toFixed(2)} per unit`}`).join(' · ')
                : 'No rewards set.'}
            </div>
          )}
        </section>
      ))}
      <div className="flex max-w-[420px] gap-2">
        <Input placeholder="New partner type, e.g. Carpenter" value={name} onChange={(e) => setName(e.target.value)} />
        <Button disabled={name.trim().length < 2} onClick={() => void addType()}>
          Add type
        </Button>
      </div>
    </div>
  );
}
