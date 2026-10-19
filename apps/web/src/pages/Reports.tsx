import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatPaise, formatQty, periodRange } from '@kph/core';
import { ApiError, download, get, put } from '../lib/api';
import { MODE_LABEL, fmtDate, fmtDateTime, todayIst } from '../lib/format';
import { useSession } from '../lib/session';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Field, Input, Notice, PageTitle, Select, Spinner, Table, cx, useToast } from '../components/ui';
import { EwayModal } from '../components/Eway';

/**
 * Registers, GST returns (GSTR-1, GSTR-3B), discounts and e-way bills, each downloadable as Excel for the CA.
 */

type Tab = 'sales' | 'purchases' | 'gstr1' | 'gstr3b' | 'discounts' | 'eway' | 'pl' | 'profit' | 'stock' | 'balance' | 'tally';
const TABS: { id: Tab; label: string; cost?: true }[] = [
  { id: 'pl', label: 'Profit & Loss', cost: true },
  { id: 'profit', label: 'Profit by item', cost: true },
  { id: 'stock', label: 'Stock value', cost: true },
  { id: 'balance', label: 'Balance summary', cost: true },
  { id: 'gstr1', label: 'GSTR-1' },
  { id: 'gstr3b', label: 'GSTR-3B' },
  { id: 'sales', label: 'Sales register' },
  { id: 'purchases', label: 'Purchase register' },
  { id: 'discounts', label: 'Discounts' },
  { id: 'eway', label: 'E-way bills' },
  { id: 'tally', label: 'Tally export' },
];

const ENDPOINT: Record<Tab, string> = {
  sales: '/api/reports/sales-register',
  purchases: '/api/reports/purchase-register',
  gstr1: '/api/reports/gstr1',
  gstr3b: '/api/reports/gstr3b',
  discounts: '/api/reports/discounts',
  eway: '/api/reports/eway-pending',
  pl: '/api/reports/profit-loss',
  profit: '/api/reports/profit-by',
  stock: '/api/reports/stock-value',
  balance: '/api/reports/balance-summary',
  tally: '',
};

const rs = (p: number | null | undefined) => (p == null ? '' : formatPaise(p));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Last month by default: GST returns are filed for the month that just ended. */
function lastMonth() {
  const [y, m] = todayIst().split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function quarters() {
  const [y, m] = todayIst().split('-').map(Number) as [number, number];
  const fy = m >= 4 ? y : y - 1;
  const out: { value: string; label: string }[] = [];
  for (const f of [fy, fy - 1])
    for (const q of [4, 3, 2, 1]) {
      const start = [4, 7, 10, 1][q - 1]!;
      out.push({ value: `${f}-Q${q}`, label: `Q${q} ${f}-${String((f + 1) % 100).padStart(2, '0')} (${MONTHS[start - 1]}–${MONTHS[start + 1]})` });
    }
  return out;
}

export function Reports() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const tabs = TABS.filter((t) => !t.cost || can('products.view_cost'));
  const tab = (tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]!.id) as Tab;
  const [by, setBy] = useState<'product' | 'category' | 'brand'>('product');
  const [kind, setKind] = useState<'month' | 'quarter' | 'dates'>('month');
  const [month, setMonth] = useState(lastMonth());
  const [quarter, setQuarter] = useState(quarters()[0]!.value);
  const [from, setFrom] = useState(`${todayIst().slice(0, 8)}01`);
  const [to, setTo] = useState(todayIst());
  const [downloading, setDownloading] = useState(false);

  const periodQuery = kind === 'month' ? `period=${month}` : kind === 'quarter' ? `period=${quarter}` : `from=${from}&to=${to}`;
  const range = useMemo(() => {
    try {
      return kind === 'dates' ? { from, to } : periodRange(kind === 'month' ? month : quarter);
    } catch {
      return { from, to };
    }
  }, [kind, month, quarter, from, to]);
  /** Stock and balance are "as on" the end of the period (or today, if the period isn't over). */
  const asOf = range.to > todayIst() ? todayIst() : range.to;
  const query = tab === 'stock' || tab === 'balance' ? `asOf=${asOf}` : tab === 'profit' ? `${periodQuery}&by=${by}` : periodQuery;
  const data = useQuery({ queryKey: ['reports', tab, query], queryFn: () => get(`${ENDPOINT[tab]}?${query}`), retry: false, enabled: tab !== 'tally' });

  const excel = async () => {
    setDownloading(true);
    try {
      await download(`${ENDPOINT[tab]}?${query}&format=xlsx`, `${tab}.xlsx`);
    } catch (e) {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not download' });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Page wide>
      <PageTitle telugu="నివేదికలు" title="Reports" sub="Registers and GST returns from the saved bills. Download the Excel for your CA." />

      <div className="flex flex-wrap items-end gap-3 rounded-[6px] border border-line bg-white p-3">
        <Field label="Period">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
            <option value="dates">Dates</option>
          </Select>
        </Field>
        {kind === 'month' && (
          <Field label="Month">
            <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </Field>
        )}
        {kind === 'quarter' && (
          <Field label="Quarter">
            <Select value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              {quarters().map((q) => (
                <option key={q.value} value={q.value}>
                  {q.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {kind === 'dates' && (
          <>
            <Field label="From">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </>
        )}
        <div className="ml-auto">
          {tab !== 'eway' && tab !== 'balance' && tab !== 'tally' && (
            <Button variant="primary" onClick={() => void excel()} busy={downloading} disabled={!data.data}>
              Download Excel
            </Button>
          )}
        </div>
      </div>

      <nav aria-label="Reports" className="flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setParams({ tab: t.id })}
            className={cx('h-11 px-3 text-sm', tab === t.id ? 'font-bold text-ink shadow-[inset_0_-3px_0_#c2491a]' : 'text-ink-3 hover:text-ink')}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {data.isLoading && (
        <div className="flex items-center gap-2 py-6 text-ink-3">
          <Spinner /> Working it out…
        </div>
      )}
      {data.error && <Notice tone="bad">{data.error instanceof ApiError ? data.error.message : 'Could not load the report'}</Notice>}
      {data.data && tab === 'gstr1' && <Gstr1View d={data.data} />}
      {data.data && tab === 'gstr3b' && <Gstr3bView d={data.data} />}
      {data.data && tab === 'sales' && <SalesView d={data.data} />}
      {data.data && tab === 'purchases' && <PurchasesView d={data.data} />}
      {data.data && tab === 'discounts' && <DiscountView d={data.data} />}
      {data.data && tab === 'eway' && <EwayView rows={data.data} />}
      {data.data && tab === 'pl' && <PLView d={data.data} />}
      {data.data && tab === 'profit' && <ProfitByView d={data.data} by={by} setBy={setBy} />}
      {data.data && tab === 'stock' && <StockView d={data.data} />}
      {data.data && tab === 'balance' && <BalanceView d={data.data} />}
      {tab === 'tally' && <TallyView range={range} periodQuery={periodQuery} />}
    </Page>
  );
}

// ------------------------------------------------------------------ bits

function Tiles({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode }[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
      {items.map((t) => (
        <div key={t.label} className="rounded-[6px] border border-line bg-white px-3 py-2.5">
          <div className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">{t.label}</div>
          <div className="num mt-0.5 text-[20px] font-extrabold">{t.value}</div>
          {t.sub && <div className="text-[12px] text-ink-3">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[6px] border border-line bg-white">
      <h2 className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-[15px] font-bold">
        {title} {count != null && <Badge>{count}</Badge>}
      </h2>
      {children}
    </section>
  );
}

const R = ({ children, b }: { children: ReactNode; b?: boolean }) => <td className={cx('num text-right whitespace-nowrap', b && 'font-bold')}>{children}</td>;

// ------------------------------------------------------------------ GSTR-1

interface G1 {
  b2b: { gstin: string; name: string; number: string; date: string; value: number; pos: string; rate: number; taxable: number; igst: number; cgst: number; sgst: number }[];
  b2cl: { number: string; date: string; value: number; pos: string; rate: number; taxable: number; igst: number }[];
  b2cs: { pos: string; rate: number; taxable: number; igst: number; cgst: number; sgst: number }[];
  cdnr: { gstin: string; name: string; number: string; date: string; value: number; rate: number; taxable: number; invoiceNumber: string }[];
  cdnur: { number: string; date: string; value: number; pos: string; rate: number; taxable: number; invoiceNumber: string }[];
  hsnB2b: Hsn[];
  hsnB2c: Hsn[];
  docs: { nature: string; from: string; to: string; total: number; cancelled: number }[];
  summary: Record<'b2b' | 'b2cl' | 'b2cs' | 'cdnr' | 'cdnur', { count: number; taxable: number; tax: number }>;
  warnings: string[];
}
interface Hsn {
  hsn: string;
  description: string;
  uqc: string;
  qty: number;
  value: number;
  rate: number;
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
}

function Gstr1View({ d }: { d: G1 }) {
  const s = d.summary;
  return (
    <div className="flex flex-col gap-4">
      {d.warnings.map((w, i) => (
        <Notice key={i} tone="warn">
          {w}
        </Notice>
      ))}
      <Tiles
        items={[
          { label: 'B2B (4A)', value: `₹${rs(s.b2b.taxable)}`, sub: `${s.b2b.count} bills · tax ₹${rs(s.b2b.tax)}` },
          { label: 'B2C large (5)', value: `₹${rs(s.b2cl.taxable)}`, sub: `${s.b2cl.count} bills · tax ₹${rs(s.b2cl.tax)}` },
          { label: 'B2C others (7)', value: `₹${rs(s.b2cs.taxable)}`, sub: `${s.b2cs.count} bills, less returns` },
          { label: 'Credit notes B2B (9B)', value: `₹${rs(s.cdnr.taxable)}`, sub: `${s.cdnr.count} notes` },
          { label: 'Credit notes B2CL (9B)', value: `₹${rs(s.cdnur.taxable)}`, sub: `${s.cdnur.count} notes` },
          { label: 'Documents (13)', value: d.docs.reduce((a, x) => a + x.total, 0), sub: `${d.docs.reduce((a, x) => a + x.cancelled, 0)} cancelled` },
        ]}
      />
      <Section title="B2B — registered customers (4A)" count={d.b2b.length}>
        {d.b2b.length ? (
          <Table head={<tr><th>GSTIN</th><th>Customer</th><th>Bill</th><th>Date</th><th className="text-right">Bill value</th><th>Place of supply</th><th className="text-right">Rate</th><th className="text-right">Taxable</th><th className="text-right">IGST</th><th className="text-right">CGST</th><th className="text-right">SGST</th></tr>}>
            {d.b2b.map((r, i) => (
              <tr key={i}>
                <td className="num">{r.gstin}</td><td>{r.name}</td><td className="num">{r.number}</td><td className="num">{fmtDate(r.date)}</td><R>{rs(r.value)}</R><td>{r.pos}</td><R>{r.rate}%</R><R b>{rs(r.taxable)}</R><R>{rs(r.igst)}</R><R>{rs(r.cgst)}</R><R>{rs(r.sgst)}</R>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No bills to registered customers.</Empty>
        )}
      </Section>
      {d.b2cl.length > 0 && (
        <Section title="B2C large — other-state, over ₹1 lakh (5)" count={d.b2cl.length}>
          <Table head={<tr><th>Bill</th><th>Date</th><th className="text-right">Bill value</th><th>Place of supply</th><th className="text-right">Rate</th><th className="text-right">Taxable</th><th className="text-right">IGST</th></tr>}>
            {d.b2cl.map((r, i) => (
              <tr key={i}><td className="num">{r.number}</td><td className="num">{fmtDate(r.date)}</td><R>{rs(r.value)}</R><td>{r.pos}</td><R>{r.rate}%</R><R b>{rs(r.taxable)}</R><R>{rs(r.igst)}</R></tr>
            ))}
          </Table>
        </Section>
      )}
      <Section title="B2C others — by state and rate (7)" count={d.b2cs.length}>
        {d.b2cs.length ? (
          <Table minWidth={560} head={<tr><th>Place of supply</th><th className="text-right">Rate</th><th className="text-right">Taxable</th><th className="text-right">IGST</th><th className="text-right">CGST</th><th className="text-right">SGST</th></tr>}>
            {d.b2cs.map((r, i) => (
              <tr key={i}><td>{r.pos}</td><R>{r.rate}%</R><R b>{rs(r.taxable)}</R><R>{rs(r.igst)}</R><R>{rs(r.cgst)}</R><R>{rs(r.sgst)}</R></tr>
            ))}
          </Table>
        ) : (
          <Empty>No retail sales.</Empty>
        )}
      </Section>
      {(d.cdnr.length > 0 || d.cdnur.length > 0) && (
        <Section title="Credit notes (9B)" count={d.cdnr.length + d.cdnur.length}>
          <Table head={<tr><th>Note</th><th>Date</th><th>Against bill</th><th>Customer</th><th className="text-right">Note value</th><th className="text-right">Rate</th><th className="text-right">Taxable</th><th>Table</th></tr>}>
            {d.cdnr.map((r, i) => (
              <tr key={`r${i}`}><td className="num">{r.number}</td><td className="num">{fmtDate(r.date)}</td><td className="num">{r.invoiceNumber}</td><td>{r.name} <span className="num text-xs text-ink-3">{r.gstin}</span></td><R>{rs(r.value)}</R><R>{r.rate}%</R><R b>{rs(r.taxable)}</R><td><Badge>CDNR</Badge></td></tr>
            ))}
            {d.cdnur.map((r, i) => (
              <tr key={`u${i}`}><td className="num">{r.number}</td><td className="num">{fmtDate(r.date)}</td><td className="num">{r.invoiceNumber}</td><td>{r.pos}</td><R>{rs(r.value)}</R><R>{r.rate}%</R><R b>{rs(r.taxable)}</R><td><Badge>CDNUR</Badge></td></tr>
            ))}
          </Table>
          <p className="px-3 py-2 text-[12px] text-ink-3">Returns on other retail bills are already taken off B2C others above.</p>
        </Section>
      )}
      <HsnTable title="HSN summary — B2B (12)" rows={d.hsnB2b} />
      <HsnTable title="HSN summary — B2C (12)" rows={d.hsnB2c} />
      <Section title="Documents issued (13)">
        <Table minWidth={560} head={<tr><th>Document</th><th>From</th><th>To</th><th className="text-right">Total</th><th className="text-right">Cancelled</th></tr>}>
          {d.docs.map((r, i) => (
            <tr key={i}><td>{r.nature}</td><td className="num">{r.from}</td><td className="num">{r.to}</td><R>{r.total}</R><R>{r.cancelled}</R></tr>
          ))}
        </Table>
      </Section>
      <p className="text-[12px] text-ink-3">The Excel follows the sheet names and headings of the GST offline tool, so your CA can import or paste it. Please have them check it the first time.</p>
    </div>
  );
}

function HsnTable({ title, rows }: { title: string; rows: Hsn[] }) {
  if (!rows.length) return null;
  return (
    <Section title={title} count={rows.length}>
      <Table head={<tr><th>HSN</th><th>Description</th><th>UQC</th><th className="text-right">Qty</th><th className="text-right">Rate</th><th className="text-right">Taxable</th><th className="text-right">IGST</th><th className="text-right">CGST</th><th className="text-right">SGST</th><th className="text-right">Total value</th></tr>}>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className="num">{r.hsn || <Badge tone="bad">missing</Badge>}</td><td className="max-w-[260px] truncate">{r.description}</td><td>{r.uqc}</td><R>{formatQty(r.qty)}</R><R>{r.rate}%</R><R b>{rs(r.taxable)}</R><R>{rs(r.igst)}</R><R>{rs(r.cgst)}</R><R>{rs(r.sgst)}</R><R>{rs(r.value)}</R>
          </tr>
        ))}
      </Table>
    </Section>
  );
}

// ------------------------------------------------------------------ GSTR-3B

interface Tax {
  taxable?: number;
  igst: number;
  cgst: number;
  sgst: number;
}
function Gstr3bView({ d }: { d: { outward: Tax; outwardDetail: { sales: Tax; returns: Tax }; interStateUnregistered: { pos: string; taxable: number; igst: number }[]; itc: { purchases: Tax & { bills: number }; purchaseReturns: Tax; net: Tax }; roughPayable: number; notes: string[] } }) {
  const row = (label: ReactNode, x: Tax, opts: { b?: boolean; neg?: boolean } = {}) => {
    const v = (n: number | undefined) => (n == null ? '' : rs(opts.neg ? -n : n));
    return (
      <tr className={opts.b ? 'bg-paper' : ''}>
        <td className={opts.b ? 'font-bold' : 'pl-6 text-ink-3'}>{label}</td><R b={opts.b}>{v(x.taxable)}</R><R b={opts.b}>{v(x.igst)}</R><R b={opts.b}>{v(x.cgst)}</R><R b={opts.b}>{v(x.sgst)}</R>
      </tr>
    );
  };
  return (
    <div className="flex flex-col gap-4">
      <Tiles
        items={[
          { label: 'Output tax', value: `₹${rs(d.outward.igst + d.outward.cgst + d.outward.sgst)}`, sub: `on ₹${rs(d.outward.taxable)} taxable` },
          { label: 'Input tax credit', value: `₹${rs(d.itc.net.igst + d.itc.net.cgst + d.itc.net.sgst)}`, sub: `${d.itc.purchases.bills} purchase bills` },
          { label: 'Rough cash to pay', value: `₹${rs(d.roughPayable)}`, sub: 'before set-off rules' },
        ]}
      />
      <Section title="GSTR-3B working">
        <Table head={<tr><th>Table</th><th className="text-right">Taxable</th><th className="text-right">IGST</th><th className="text-right">CGST</th><th className="text-right">SGST</th></tr>}>
          {row('3.1(a) Outward taxable supplies', d.outward, { b: true })}
          {row('Sales bills', d.outwardDetail.sales)}
          {row('Less credit notes', d.outwardDetail.returns, { neg: true })}
          <tr className="bg-paper"><td className="font-bold" colSpan={5}>3.2 Inter-state supplies to unregistered persons</td></tr>
          {d.interStateUnregistered.length ? d.interStateUnregistered.map((x) => row(x.pos, { taxable: x.taxable, igst: x.igst, cgst: 0, sgst: 0 })) : <tr><td className="pl-6 text-ink-3" colSpan={5}>None</td></tr>}
          {row('4(A)(5) All other ITC', d.itc.net, { b: true })}
          {row('Purchase bills', d.itc.purchases)}
          {row('Less purchase returns (debit notes)', d.itc.purchaseReturns, { neg: true })}
        </Table>
      </Section>
      {d.notes.map((n, i) => (
        <Notice key={i} tone="teal">
          {n}
        </Notice>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ registers

function SalesView({ d }: { d: { invoices: { id: number; number: string; invoice_date: string; customer_name: string | null; customer_gstin: string | null; payment_mode: string; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; total_paise: number; status: string; ewb_no: string | null }[]; creditNotes: { id: number; number: string; note_date: string; invoice_number: string; customer_name: string | null; total_paise: number; taxable_paise: number; status: string }[]; totals: { bills: number; cancelled: number; taxable: number; cgst: number; sgst: number; igst: number; total: number; discount: number; returnsTotal: number } } }) {
  const t = d.totals;
  return (
    <div className="flex flex-col gap-4">
      <Tiles
        items={[
          { label: 'Sales', value: `₹${rs(t.total)}`, sub: `${t.bills} bills${t.cancelled ? ` · ${t.cancelled} cancelled` : ''}` },
          { label: 'Taxable', value: `₹${rs(t.taxable)}` },
          { label: 'GST', value: `₹${rs(t.cgst + t.sgst + t.igst)}`, sub: `CGST ${rs(t.cgst)} · SGST ${rs(t.sgst)} · IGST ${rs(t.igst)}` },
          { label: 'Discount given', value: `₹${rs(t.discount)}` },
          { label: 'Returns', value: `₹${rs(t.returnsTotal)}`, sub: `${d.creditNotes.length} credit notes` },
        ]}
      />
      <Section title="Bills" count={d.invoices.length}>
        {d.invoices.length ? (
          <Table head={<tr><th>Bill</th><th>Date</th><th>Customer</th><th>Payment</th><th className="text-right">Taxable</th><th className="text-right">CGST</th><th className="text-right">SGST</th><th className="text-right">IGST</th><th className="text-right">Total</th><th>E-way bill</th></tr>}>
            {d.invoices.map((r) => (
              <tr key={r.id} className={r.status === 'cancelled' ? 'text-ink-3 line-through' : ''}>
                <td className="num font-semibold">{r.number}</td><td className="num">{fmtDate(r.invoice_date)}</td><td>{r.customer_name ?? 'Walk-in'} {r.customer_gstin && <span className="num text-xs text-ink-3">{r.customer_gstin}</span>}</td>
                <td>{MODE_LABEL[r.payment_mode]}</td><R>{rs(r.taxable_paise)}</R><R>{rs(r.cgst_paise)}</R><R>{rs(r.sgst_paise)}</R><R>{rs(r.igst_paise)}</R><R b>{rs(r.total_paise)}</R><td className="num">{r.ewb_no ?? ''}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No bills in this period.</Empty>
        )}
      </Section>
      {d.creditNotes.length > 0 && (
        <Section title="Credit notes (sales returns)" count={d.creditNotes.length}>
          <Table minWidth={560} head={<tr><th>Note</th><th>Date</th><th>Against bill</th><th>Customer</th><th className="text-right">Taxable</th><th className="text-right">Total</th></tr>}>
            {d.creditNotes.map((r) => (
              <tr key={r.id} className={r.status === 'cancelled' ? 'text-ink-3 line-through' : ''}><td className="num">{r.number}</td><td className="num">{fmtDate(r.note_date)}</td><td className="num">{r.invoice_number}</td><td>{r.customer_name ?? 'Walk-in'}</td><R>{rs(r.taxable_paise)}</R><R b>{rs(r.total_paise)}</R></tr>
            ))}
          </Table>
        </Section>
      )}
    </div>
  );
}

function PurchasesView({ d }: { d: { purchases: { id: number; number: string; supplier_invoice_no: string; supplier_invoice_date: string; supplier_name: string; supplier_gstin: string | null; taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; freight_paise: number; total_paise: number; status: string }[]; debitNotes: { id: number; number: string; note_date: string; supplier_name: string; supplier_invoice_no: string; total_paise: number; status: string }[]; totals: { bills: number; taxable: number; cgst: number; sgst: number; igst: number; freight: number; total: number; returnsTotal: number } } }) {
  const t = d.totals;
  return (
    <div className="flex flex-col gap-4">
      <Tiles
        items={[
          { label: 'Purchases', value: `₹${rs(t.total)}`, sub: `${t.bills} supplier bills` },
          { label: 'Taxable', value: `₹${rs(t.taxable)}` },
          { label: 'Input GST', value: `₹${rs(t.cgst + t.sgst + t.igst)}`, sub: `CGST ${rs(t.cgst)} · SGST ${rs(t.sgst)} · IGST ${rs(t.igst)}` },
          { label: 'Freight', value: `₹${rs(t.freight)}` },
          { label: 'Returns', value: `₹${rs(t.returnsTotal)}`, sub: `${d.debitNotes.length} debit notes` },
        ]}
      />
      <Section title="Supplier bills (by bill date)" count={d.purchases.length}>
        {d.purchases.length ? (
          <Table head={<tr><th>Supplier bill</th><th>Date</th><th>Supplier</th><th>Our no</th><th className="text-right">Taxable</th><th className="text-right">CGST</th><th className="text-right">SGST</th><th className="text-right">IGST</th><th className="text-right">Total</th></tr>}>
            {d.purchases.map((r) => (
              <tr key={r.id} className={r.status === 'cancelled' ? 'text-ink-3 line-through' : ''}>
                <td className="num font-semibold">{r.supplier_invoice_no}</td><td className="num">{fmtDate(r.supplier_invoice_date)}</td><td>{r.supplier_name} {r.supplier_gstin && <span className="num text-xs text-ink-3">{r.supplier_gstin}</span>}</td>
                <td className="num text-ink-3">{r.number}</td><R>{rs(r.taxable_paise)}</R><R>{rs(r.cgst_paise)}</R><R>{rs(r.sgst_paise)}</R><R>{rs(r.igst_paise)}</R><R b>{rs(r.total_paise)}</R>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No purchase bills dated in this period.</Empty>
        )}
      </Section>
      {d.debitNotes.length > 0 && (
        <Section title="Debit notes (returns to suppliers)" count={d.debitNotes.length}>
          <Table minWidth={560} head={<tr><th>Note</th><th>Date</th><th>Supplier</th><th>Supplier bill</th><th className="text-right">Total</th></tr>}>
            {d.debitNotes.map((r) => (
              <tr key={r.id}><td className="num">{r.number}</td><td className="num">{fmtDate(r.note_date)}</td><td>{r.supplier_name}</td><td className="num">{r.supplier_invoice_no}</td><R b>{rs(r.total_paise)}</R></tr>
            ))}
          </Table>
        </Section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ discounts

function DiscountView({ d }: { d: { byStaff: { user_id: number; name: string; bills: number; gross: number; discount: number; over_limit_lines: number; over_limit_discount: number }[]; byProduct: { product_id: number; name: string; unit_code: string; qty: number; gross: number; discount: number; discounted_lines: number; max_bp: number; over_limit_lines: number }[]; overLimit: { invoice_id: number; number: string; invoice_date: string; product_name: string; discount_bp: number; max_discount_bp: number; discount_paise: number; staff: string; approved_by: string; reason: string | null }[]; totals: { gross: number; discount: number; overLimitLines: number } } }) {
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(2)}%` : '—');
  const top = Math.max(1, ...d.byStaff.map((x) => x.discount));
  return (
    <div className="flex flex-col gap-4">
      <Tiles
        items={[
          { label: 'Discount given', value: `₹${rs(d.totals.discount)}`, sub: `${pct(d.totals.discount, d.totals.gross)} of ₹${rs(d.totals.gross)}` },
          { label: 'Admin-approved', value: d.totals.overLimitLines, sub: 'lines above the limit' },
        ]}
      />
      <Section title="By staff member" count={d.byStaff.length}>
        <Table minWidth={640} head={<tr><th>Staff</th><th className="text-right">Bills</th><th className="text-right">Gross</th><th className="text-right">Discount</th><th className="w-[30%]">Share</th><th className="text-right">Above limit</th></tr>}>
          {d.byStaff.map((r) => (
            <tr key={r.user_id}>
              <td className="font-semibold">{r.name}</td><R>{r.bills}</R><R>{rs(r.gross)}</R><R b>{rs(r.discount)}</R>
              <td>
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-concrete"><div className="h-2 rounded-full bg-teal" style={{ width: `${(r.discount / top) * 100}%` }} /></div>
                  <span className="num w-14 text-right text-[12px] text-ink-3">{pct(r.discount, r.gross)}</span>
                </div>
              </td>
              <R>{r.over_limit_lines ? <Badge tone="warn">{r.over_limit_lines} · ₹{rs(r.over_limit_discount)}</Badge> : '—'}</R>
            </tr>
          ))}
        </Table>
      </Section>
      <Section title="By product" count={d.byProduct.length}>
        {d.byProduct.length ? (
          <Table head={<tr><th>Product</th><th className="text-right">Qty sold</th><th className="text-right">Gross</th><th className="text-right">Discount</th><th className="text-right">Avg %</th><th className="text-right">Highest %</th><th className="text-right">Above limit</th></tr>}>
            {d.byProduct.map((r) => (
              <tr key={r.product_id}><td>{r.name}</td><R>{formatQty(r.qty)} {r.unit_code}</R><R>{rs(r.gross)}</R><R b>{rs(r.discount)}</R><R>{pct(r.discount, r.gross)}</R><R>{(r.max_bp / 100).toFixed(2)}%</R><R>{r.over_limit_lines || '—'}</R></tr>
            ))}
          </Table>
        ) : (
          <Empty>No discounts in this period.</Empty>
        )}
      </Section>
      {d.overLimit.length > 0 && (
        <Section title="Above the limit — approved with the admin PIN" count={d.overLimit.length}>
          <Table head={<tr><th>Bill</th><th>Date</th><th>Product</th><th className="text-right">Given</th><th className="text-right">Limit</th><th className="text-right">Discount</th><th>Staff</th><th>Approved by</th></tr>}>
            {d.overLimit.map((r, i) => (
              <tr key={i}><td className="num">{r.number}</td><td className="num">{fmtDate(r.invoice_date)}</td><td>{r.product_name}</td><R b>{(r.discount_bp / 100).toFixed(2)}%</R><R>{(r.max_discount_bp / 100).toFixed(2)}%</R><R>{rs(r.discount_paise)}</R><td>{r.staff}</td><td>{r.approved_by}</td></tr>
            ))}
          </Table>
        </Section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ e-way bills

function EwayView({ rows }: { rows: { id: number; number: string; invoice_date: string; customer_name: string | null; total_paise: number; ewb_no: string | null; not_needed_reason: string | null; vehicle_no: string | null; state: 'done' | 'pending' | 'not_needed' }[] }) {
  const { can } = useSession();
  const [open, setOpen] = useState<number | null>(null);
  const pending = useMemo(() => rows.filter((r) => r.state === 'pending').length, [rows]);
  return (
    <div className="flex flex-col gap-4">
      <Tiles items={[{ label: 'Bills over ₹50,000', value: rows.length }, { label: 'Still without e-way bill', value: pending, sub: pending ? 'open each to fill in' : 'all done' }]} />
      <Section title="Bills that need an e-way bill" count={rows.length}>
        {rows.length ? (
          <Table minWidth={640} head={<tr><th>Bill</th><th>Date</th><th>Customer</th><th className="text-right">Total</th><th>E-way bill</th><th /></tr>}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="num font-semibold">{r.number}</td><td className="num">{fmtDate(r.invoice_date)}</td><td>{r.customer_name ?? 'Walk-in'}</td><R>{rs(r.total_paise)}</R>
                <td>{r.state === 'done' ? <span className="num">{r.ewb_no}</span> : r.state === 'not_needed' ? <Badge>Not needed · {r.not_needed_reason}</Badge> : <Badge tone="warn">Pending</Badge>}</td>
                <td className="text-right">{can('billing.create') && <Button size="sm" onClick={() => setOpen(r.id)}>{r.state === 'pending' ? 'Fill in…' : 'Open'}</Button>}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No bills over ₹50,000 in this period.</Empty>
        )}
      </Section>
      {open != null && <EwayModal invoiceId={open} open onClose={() => setOpen(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ profit & loss

const pct = (bp: number) => `${(bp / 100).toFixed(1)}%`;
const money = (p: number) => (p < 0 ? `−₹${rs(-p)}` : `₹${rs(p)}`);

function PLView({ d }: { d: { sales: number; salesReturns: number; netSales: number; costOfSales: number; costOfReturns: number; cogs: number; stockLossPaise: number; grossProfit: number; grossMarginBp: number; directExpenses: { name: string; amount: number }[]; indirectExpenses: { name: string; amount: number }[]; otherIncome: { name: string; amount: number }[]; netProfit: number; netMarginBp: number; linesWithoutCost: number; notes: string[] } }) {
  const Row = ({ label, value, strong, sub, minus }: { label: ReactNode; value: number; strong?: boolean; sub?: boolean; minus?: boolean }) => (
    <tr className={strong ? 'bg-paper' : ''}>
      <td className={cx(strong ? 'font-bold' : sub ? 'pl-8 text-ink-3' : 'pl-4')}>{label}</td>
      <td className={cx('num text-right', strong && 'text-[16px] font-extrabold', value < 0 && strong && 'text-bad')}>
        {minus ? (value > 0 ? '− ' : value < 0 ? '+ ' : '') : value < 0 ? '− ' : ''}₹{rs(Math.abs(value))}
        {strong && value < 0 ? ' (loss)' : ''}
      </td>
    </tr>
  );
  return (
    <div className="flex flex-col gap-4">
      {d.linesWithoutCost > 0 && <Notice tone="warn">{d.linesWithoutCost} bill line(s) were sold before the product had a cost price, so their cost is counted as zero. Enter cost prices in Inventory.</Notice>}
      <Tiles
        items={[
          { label: 'Net sales', value: money(d.netSales), sub: 'before GST, less returns' },
          { label: 'Gross profit', value: money(d.grossProfit), sub: `${pct(d.grossMarginBp)} of sales` },
          { label: 'Expenses', value: money([...d.directExpenses, ...d.indirectExpenses].reduce((t, x) => t + x.amount, 0)), sub: 'incl. round-off on bills' },
          { label: 'Net profit', value: money(d.netProfit), sub: `${pct(d.netMarginBp)} of sales` },
        ]}
      />
      <Section title="Profit & Loss">
        <Table minWidth={480} head={<tr><th>Particulars</th><th className="text-right">Amount</th></tr>}>
          <Row label="Sales (before GST)" value={d.sales} />
          <Row label="Less sales returns" value={d.salesReturns} minus />
          <Row label="Net sales" value={d.netSales} strong />
          <Row label="Cost of goods sold" value={d.costOfSales} minus />
          <Row label="Add back cost of goods returned" value={d.costOfReturns} />
          {d.stockLossPaise !== 0 && <Row label={d.stockLossPaise > 0 ? 'Stock written off (damaged, lost, count short)' : 'Stock found on counting'} value={Math.abs(d.stockLossPaise)} minus={d.stockLossPaise > 0} />}
          <Row label="Gross profit" value={d.grossProfit} strong />
          {d.directExpenses.map((x) => <Row key={x.name} label={x.name} value={x.amount} minus sub />)}
          {d.indirectExpenses.map((x) => <Row key={x.name} label={x.name} value={x.amount} minus sub />)}
          {d.otherIncome.map((x) => <Row key={x.name} label={`${x.name} (income)`} value={x.amount} sub />)}
          <Row label="Net profit" value={d.netProfit} strong />
        </Table>
      </Section>
      {d.notes.map((n, i) => (
        <p key={i} className="text-[12px] text-ink-3">
          {n}
        </p>
      ))}
    </div>
  );
}

type ProfitRow = { key: string; name: string; unit_code: string | null; qty: number; sales: number; cost: number; profit: number; marginBp: number; unknown_cost_lines: number };

function ProfitByView({ d, by, setBy }: { d: { rows: ProfitRow[]; totals: { sales: number; cost: number; profit: number; marginBp: number; unknownCostLines: number } }; by: 'product' | 'category' | 'brand'; setBy: (b: 'product' | 'category' | 'brand') => void }) {
  const top = Math.max(1, ...d.rows.map((r) => Math.abs(r.profit)));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {(['product', 'category', 'brand'] as const).map((b) => (
          <Button key={b} size="sm" variant={by === b ? 'dark' : 'secondary'} onClick={() => setBy(b)}>
            By {b}
          </Button>
        ))}
        <span className="num ml-auto text-sm">
          Profit <b>₹{rs(d.totals.profit)}</b> on ₹{rs(d.totals.sales)} · {pct(d.totals.marginBp)}
        </span>
      </div>
      {d.totals.unknownCostLines > 0 && <Notice tone="warn">Some lines had no cost price when sold; their profit is overstated.</Notice>}
      <Section title={`Profit by ${by}`} count={d.rows.length}>
        {d.rows.length ? (
          <Table
            head={
              <tr>
                <th>{by === 'product' ? 'Product' : by === 'category' ? 'Category' : 'Brand'}</th>
                {by === 'product' && <th className="text-right">Qty</th>}
                <th className="text-right">Sales</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Profit</th>
                <th className="w-[22%]">Margin</th>
              </tr>
            }
          >
            {d.rows.map((r) => (
              <tr key={r.key}>
                <td>
                  {r.name} {r.unknown_cost_lines > 0 && <Badge tone="warn">no cost</Badge>}
                </td>
                {by === 'product' && (
                  <R>
                    {formatQty(r.qty)} {r.unit_code}
                  </R>
                )}
                <R>{rs(r.sales)}</R>
                <R>{rs(r.cost)}</R>
                <R b>{rs(r.profit)}</R>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-concrete">
                      <div className={cx('h-2 rounded-full', r.profit < 0 ? 'bg-bad' : 'bg-teal')} style={{ width: `${(Math.abs(r.profit) / top) * 100}%` }} />
                    </div>
                    <span className={cx('num w-12 text-right text-[12px]', r.marginBp < 0 ? 'text-bad' : 'text-ink-3')}>{pct(r.marginBp)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>No sales in this period.</Empty>
        )}
      </Section>
    </div>
  );
}

function StockView({ d }: { d: { asOf: string; rows: { id: number; sku: string; name: string; unit_code: string; category: string | null; qty: number; cost: number | null; value: number }[]; byCategory: { name: string; value: number }[]; totals: { value: number; items: number; negative: number; noCost: number } } }) {
  return (
    <div className="flex flex-col gap-4">
      <Tiles
        items={[
          { label: 'Stock at cost', value: `₹${rs(d.totals.value)}`, sub: `on ${fmtDate(d.asOf)}` },
          { label: 'Items in stock', value: d.totals.items },
          ...d.byCategory.slice(0, 4).map((c) => ({ label: c.name, value: `₹${rs(c.value)}` })),
        ]}
      />
      {d.totals.noCost > 0 && <Notice tone="warn">{d.totals.noCost} item(s) in stock have no cost price, so they are valued at zero.</Notice>}
      {d.totals.negative > 0 && <Notice tone="warn">{d.totals.negative} item(s) show negative stock. Check them in Inventory.</Notice>}
      <Section title="Stock at weighted-average cost" count={d.rows.length}>
        <Table head={<tr><th>Product</th><th>Category</th><th className="text-right">Qty</th><th className="text-right">Cost / unit</th><th className="text-right">Value</th></tr>}>
          {d.rows.map((r) => (
            <tr key={r.id} className={r.qty < 0 ? 'text-bad' : ''}>
              <td>
                {r.name} <span className="num text-[12px] text-ink-3">{r.sku}</span>
              </td>
              <td className="text-ink-3">{r.category}</td>
              <R>
                {formatQty(r.qty)} {r.unit_code}
              </R>
              <R>{r.cost == null ? '—' : rs(r.cost)}</R>
              <R b>{rs(r.value)}</R>
            </tr>
          ))}
        </Table>
      </Section>
      <p className="text-[12px] text-ink-3">For a past date the quantities are exact; they are valued at today&apos;s average cost.</p>
    </div>
  );
}

function BalanceView({ d }: { d: { asOf: string; assets: { name: string; amount: number }[]; liabilities: { name: string; amount: number }[]; totalAssets: number; totalLiabilities: number; ownersFunds: number } }) {
  const list = (xs: { name: string; amount: number }[]) =>
    xs.map((x) => (
      <tr key={x.name}>
        <td>{x.name}</td>
        <R>{rs(x.amount)}</R>
      </tr>
    ));
  return (
    <div className="flex flex-col gap-4">
      <Tiles
        items={[
          { label: 'What the shop has', value: `₹${rs(d.totalAssets)}` },
          { label: 'What it owes', value: `₹${rs(d.totalLiabilities)}` },
          { label: 'Owner’s funds', value: `₹${rs(d.ownersFunds)}`, sub: `on ${fmtDate(d.asOf)}` },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Has">
          <Table minWidth={320} head={<tr><th>Item</th><th className="text-right">Amount</th></tr>}>
            {list(d.assets)}
            <tr className="bg-paper font-bold">
              <td>Total</td>
              <R b>{rs(d.totalAssets)}</R>
            </tr>
          </Table>
        </Section>
        <Section title="Owes">
          <Table minWidth={320} head={<tr><th>Item</th><th className="text-right">Amount</th></tr>}>
            {list(d.liabilities)}
            <tr className="bg-paper font-bold">
              <td>Total</td>
              <R b>{rs(d.totalLiabilities)}</R>
            </tr>
          </Table>
        </Section>
      </div>
      <p className="text-[12px] text-ink-3">A simple picture, not a formal balance sheet: stock is at weighted-average cost, and fixed assets appear only if entered in the accounts. Your CA prepares the final accounts.</p>
    </div>
  );
}

// ------------------------------------------------------------------ Tally

interface TallyName {
  ledgerId: number;
  name: string;
  group: string;
  partyType: string | null;
  tallyName: string;
  custom: boolean;
  changed: boolean;
}

function TallyView({ range, periodQuery }: { range: { from: string; to: string }; periodQuery: string }) {
  const { can } = useSession();
  const toast = useToast();
  const names = useQuery({ queryKey: ['reports', 'tally-names'], queryFn: () => get<TallyName[]>('/api/tally/names') });
  const history = useQuery({ queryKey: ['reports', 'tally-exports'], queryFn: () => get<{ id: number; what: string; from_date: string | null; to_date: string | null; voucher_count: number; at: string; user_name: string }[]>('/api/tally/exports') });
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Record<number, string>>({});
  const overlap = (history.data ?? []).some((h) => h.what === 'vouchers' && h.from_date && h.to_date && h.from_date <= range.to && h.to_date >= range.from);

  const fetchFile = async (what: string, path: string, name: string) => {
    setBusy(what);
    try {
      await download(path, name);
      void history.refetch();
    } catch (e) {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not download' });
    } finally {
      setBusy(null);
    }
  };
  const stopEditing = (id: number) =>
    setEditing((e) => {
      const n = { ...e };
      delete n[id];
      return n;
    });
  const saveName = async (ledgerId: number, value: string | null) => {
    try {
      await put(`/api/tally/names/${ledgerId}`, { tallyName: value });
      stopEditing(ledgerId);
      void names.refetch();
    } catch (e) {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not save' });
    }
  };

  const rows = (names.data ?? []).filter((n) => !filter || `${n.name} ${n.tallyName} ${n.group}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex flex-col gap-4">
      <Section title="Export to TallyPrime">
        <div className="flex flex-col gap-3 p-3 text-sm">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <b>First time:</b> in Tally, make a <b>copy of the company</b> (or a test company) and import there first.
            </li>
            <li>
              Import <b>masters</b> (ledgers) once, and again whenever new customers, suppliers or accounts are added. Stock items are optional; the vouchers are accounts-only.
            </li>
            <li>
              Import the <b>vouchers</b> for the period: TallyPrime → Gateway → <b>Import</b> → Transactions → choose the XML file.
            </li>
            <li>Check that the trial balance in Tally matches Accounts → Books → Trial balance here.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void fetchFile('masters', '/api/tally/masters.xml', 'tally-masters.xml')} busy={busy === 'masters'}>
              Masters (ledgers)
            </Button>
            <Button onClick={() => void fetchFile('stock', '/api/tally/stock-items.xml', 'tally-stock-items.xml')} busy={busy === 'stock'}>
              Stock items (optional)
            </Button>
            <Button variant="primary" onClick={() => void fetchFile('vouchers', `/api/tally/vouchers.xml?${periodQuery}`, 'tally-vouchers.xml')} busy={busy === 'vouchers'}>
              Vouchers {fmtDate(range.from)} – {fmtDate(range.to)}
            </Button>
          </div>
          {overlap && <Notice tone="warn">Vouchers for part of this period were exported before. Importing them again into the same Tally company can make duplicates. Check before importing.</Notice>}
          <p className="text-[12px] text-ink-3">Format: TallyPrime XML (Import Data), for TallyPrime 3.0 and later. The company name in the file comes from Settings → Shop &amp; billing (blank = shop name).</p>
        </div>
      </Section>

      <Section title="Account names in Tally" count={names.data?.length}>
        <div className="p-3">
          <p className="mb-2 text-[13px] text-ink-3">
            If your CA&apos;s Tally uses different names (e.g. “Sales @ 18%” instead of “Sales”), set them here so the vouchers land on the right ledgers. Names marked <Badge tone="warn">changed</Badge> were made unique automatically.
          </p>
          <Input placeholder="Search accounts…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-[320px]" />
        </div>
        <Table head={<tr><th>Our account</th><th>Group</th><th>Name in Tally</th><th /></tr>}>
          {rows.slice(0, 300).map((n) => (
            <tr key={n.ledgerId}>
              <td>{n.name}</td>
              <td className="text-ink-3">{n.group}</td>
              <td>
                {editing[n.ledgerId] != null ? (
                  <Input
                    autoFocus
                    aria-label={`Tally name for ${n.name}`}
                    value={editing[n.ledgerId]}
                    onChange={(e) => setEditing((x) => ({ ...x, [n.ledgerId]: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && void saveName(n.ledgerId, editing[n.ledgerId] || null)}
                  />
                ) : (
                  <span>
                    {n.tallyName} {n.custom ? <Badge tone="teal">set</Badge> : n.changed ? <Badge tone="warn">changed</Badge> : null}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap text-right">
                {can('accounts.manage') &&
                  (editing[n.ledgerId] != null ? (
                    <>
                      <Button size="sm" variant="primary" onClick={() => void saveName(n.ledgerId, editing[n.ledgerId] || null)}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => stopEditing(n.ledgerId)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing((x) => ({ ...x, [n.ledgerId]: n.tallyName }))}>
                        Rename
                      </Button>
                      {n.custom && (
                        <Button size="sm" variant="ghost" onClick={() => void saveName(n.ledgerId, null)}>
                          Reset
                        </Button>
                      )}
                    </>
                  ))}
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      {(history.data?.length ?? 0) > 0 && (
        <Section title="Past exports" count={history.data!.length}>
          <Table minWidth={480} head={<tr><th>When</th><th>What</th><th>Period</th><th className="text-right">Count</th><th>By</th></tr>}>
            {history.data!.map((h) => (
              <tr key={h.id}>
                <td className="num">{fmtDateTime(h.at)}</td>
                <td>{h.what.replace('_', ' ')}</td>
                <td className="num">{h.from_date ? `${fmtDate(h.from_date)} – ${fmtDate(h.to_date)}` : '—'}</td>
                <R>{h.voucher_count}</R>
                <td>{h.user_name}</td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
    </div>
  );
}
