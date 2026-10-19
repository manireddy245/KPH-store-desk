import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatPaise, formatPercent, formatQty } from '@kph/core';
import { get, qs } from '../lib/api';
import { daysAgoIst, fmtDateTime, todayIst } from '../lib/format';
import { useSession } from '../lib/session';
import { Page } from '../components/Layout';
import { Badge, Empty, Field, Input, PageTitle, Select, Spinner, Table } from '../components/ui';

interface Entry {
  id: number;
  at: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  details: Record<string, any>;
  reason: string | null;
  user_name: string | null;
  device_name: string | null;
  approved_by_name: string | null;
}

const GROUPS: [string, string][] = [
  ['', 'Everything'],
  ['invoice.', 'Bills'],
  ['discount.', 'Discounts above limit'],
  ['override.', 'Admin PIN approvals'],
  ['receipt.', 'Payments received'],
  ['stock.', 'Stock adjustments'],
  ['product.', 'Product changes'],
  ['customer.', 'Customers'],
  ['auth.', 'Logins and locks'],
  ['user.', 'Users'],
  ['device.', 'Counters'],
  ['settings.', 'Settings'],
  ['backup.', 'Backups'],
  ['import.', 'Imports'],
];

const rupees = (p?: number) => (p == null ? '' : `₹${formatPaise(p)}`);

function describe(e: Entry): string {
  const d = e.details ?? {};
  switch (e.action) {
    case 'invoice.created':
      return `Bill ${d.number} · ${rupees(d.totalPaise)} · ${d.paymentMode} · ${d.items} items`;
    case 'invoice.cancelled':
      return `Bill ${d.number} cancelled · ${rupees(d.totalPaise)}`;
    case 'discount.over_limit':
      return `${d.product}: ${formatPercent(d.discountBp ?? 0)}% (max ${formatPercent(d.maxBp ?? 0)}%) on ${d.number}`;
    case 'override.approved':
      return `Admin PIN for ${d.permission}`;
    case 'receipt.created':
      return `Receipt ${d.number} · ${rupees(d.amountPaise)} from ${d.customer}`;
    case 'stock.adjusted':
      return `${d.name}: ${formatQty(d.fromMilli ?? 0)} → ${formatQty(d.toMilli ?? 0)}`;
    case 'product.price_changed':
    case 'product.updated':
      return `${d.name}: ${Object.keys(d.changes ?? {}).join(', ')}`;
    case 'product.created':
      return `${d.name} (${d.sku})`;
    case 'auth.login':
      return 'Logged in';
    case 'auth.lock':
      return 'Locked the screen';
    case 'auth.logout':
      return 'Logged out';
    case 'auth.locked_out':
      return 'Locked out after too many wrong PINs';
    case 'import.applied':
      return `${e.entity}: ${d.create} added, ${d.update} updated, ${d.skip} skipped`;
    default:
      return d.name ?? d.number ?? '';
  }
}

export function Activity() {
  const { can } = useSession();
  const [from, setFrom] = useState(daysAgoIst(2));
  const [to, setTo] = useState(todayIst());
  const [action, setAction] = useState('');
  const q = useQuery({ queryKey: ['activity', from, to, action], queryFn: () => get<Entry[]>(`/api/activity${qs({ from, to, action })}`) });
  return (
    <Page>
      <PageTitle telugu="కార్యకలాపాలు" title="Activity log" sub={can('activity.view') ? 'Everything important, with who, which counter and when. Entries can’t be edited or deleted.' : 'Your own activity.'} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Show">
          <Select value={action} onChange={(e) => setAction(e.target.value)}>
            {GROUPS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="overflow-hidden rounded-[6px] border border-line bg-white">
        <Table
          head={
            <tr>
              <th>When</th>
              <th>Who · counter</th>
              <th>What</th>
              <th>Details</th>
            </tr>
          }
        >
          {(q.data ?? []).map((e) => (
            <tr key={e.id}>
              <td className="num whitespace-nowrap text-ink-3">{fmtDateTime(e.at)}</td>
              <td className="whitespace-nowrap">
                {e.user_name ?? 'System'}
                <span className="text-ink-3"> · {e.device_name ?? '—'}</span>
              </td>
              <td>
                <Badge tone={e.action.startsWith('discount') || e.action.startsWith('override') ? 'warn' : e.action.endsWith('cancelled') || e.action === 'auth.locked_out' ? 'bad' : 'neutral'}>{e.action}</Badge>
              </td>
              <td>
                {describe(e)}
                {e.reason && <span className="text-ink-3"> · “{e.reason}”</span>}
                {e.approved_by_name && <span className="text-ink-3"> · approved by {e.approved_by_name}</span>}
              </td>
            </tr>
          ))}
        </Table>
        {q.isLoading && (
          <div className="flex items-center gap-2 p-6 text-ink-3">
            <Spinner /> Loading…
          </div>
        )}
        {q.data?.length === 0 && <Empty>Nothing recorded in this period.</Empty>}
      </div>
    </Page>
  );
}
