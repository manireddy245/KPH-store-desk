import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, parseRupees } from '@kph/core';
import { ApiError, get, patch, post, qs } from '../lib/api';
import { useSession } from '../lib/session';
import type { SupplierRow } from '../lib/types';
import { Page } from '../components/Layout';
import { Badge, Button, Empty, Field, Input, Modal, Notice, PageTitle, Select, Spinner, Table, useDebounced, useToast } from '../components/ui';

export function Suppliers() {
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const s = useDebounced(search);
  const list = useQuery({ queryKey: ['suppliers', s], queryFn: () => get<SupplierRow[]>(`/api/suppliers${qs({ search: s, includeInactive: true })}`) });
  const [editing, setEditing] = useState<SupplierRow | 'new' | null>(null);
  const rows = list.data ?? [];
  return (
    <Page>
      <PageTitle
        telugu="సరఫరాదారులు"
        title="Suppliers"
        sub="Purchases and supplier payments come in Phase 3."
        actions={
          can('suppliers.manage') && (
            <Button variant="primary" onClick={() => setEditing('new')}>
              + Add supplier
            </Button>
          )
        }
      />
      <Input aria-label="Search suppliers" placeholder="Search name, phone or category…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="overflow-hidden rounded-[6px] border border-line bg-white">
        <Table
          head={
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Category</th>
              <th>GSTIN</th>
              <th className="text-right">Lead time</th>
              <th className="text-right">We owe</th>
              <th />
            </tr>
          }
        >
          {rows.map((r) => (
            <tr key={r.id} className={r.active ? '' : 'opacity-60'}>
              <td>
                <div className="font-bold">
                  {r.name} {!r.active && <Badge>Inactive</Badge>}
                </div>
                {r.address && <div className="text-xs text-ink-3">{r.address}</div>}
              </td>
              <td className="num">{r.phone ?? '—'}</td>
              <td>{r.category ?? '—'}</td>
              <td className="num text-ink-3">{r.gstin ?? '—'}</td>
              <td className="num text-right">{r.lead_time_days != null ? `${r.lead_time_days} days` : '—'}</td>
              <td className="num text-right font-bold">₹{formatPaise(r.payable_paise)}</td>
              <td className="text-right">
                {can('suppliers.manage') && (
                  <button type="button" className="text-[13px] font-semibold hover:underline" onClick={() => setEditing(r)}>
                    Edit
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
        {list.isLoading && (
          <div className="flex items-center gap-2 p-6 text-ink-3">
            <Spinner /> Loading…
          </div>
        )}
        {!list.isLoading && rows.length === 0 && <Empty>No suppliers yet.</Empty>}
      </div>
      <SupplierForm open={editing != null} supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
    </Page>
  );
}

function SupplierForm({ open, supplier, onClose }: { open: boolean; supplier: SupplierRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF({
      name: supplier?.name ?? '',
      phone: supplier?.phone ?? '',
      category: supplier?.category ?? '',
      gstin: supplier?.gstin ?? '',
      address: supplier?.address ?? '',
      lead: supplier?.lead_time_days != null ? String(supplier.lead_time_days) : '',
      opening: '',
      active: supplier?.active === false ? '0' : '1',
    });
  }, [open, supplier]);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async () => {
    setError(null);
    const body: Record<string, unknown> = {
      name: f.name,
      phone: f.phone || null,
      category: f.category || null,
      gstin: f.gstin || null,
      address: f.address || null,
      leadTimeDays: f.lead?.trim() ? Number(f.lead) : null,
    };
    if (supplier) body.active = f.active === '1';
    if (!supplier && f.opening?.trim()) {
      const o = parseRupees(f.opening);
      if (o == null) return setError('Opening balance is not a valid amount');
      body.openingBalancePaise = o;
    }
    setBusy(true);
    try {
      if (supplier) await patch(`/api/suppliers/${supplier.id}`, body);
      else await post('/api/suppliers', body);
      toast({ tone: 'good', text: `Saved ${f.name}` });
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={supplier ? 'Edit supplier' : 'Add supplier'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="dark" busy={busy} disabled={(f.name ?? '').trim().length < 2} onClick={submit}>
            Save supplier
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" className="sm:col-span-2">
          <Input value={f.name ?? ''} onChange={set('name')} autoFocus />
        </Field>
        <Field label="Phone">
          <Input value={f.phone ?? ''} onChange={set('phone')} inputMode="tel" />
        </Field>
        <Field label="Category" hint="e.g. Paints, Cement, Steel">
          <Input value={f.category ?? ''} onChange={set('category')} />
        </Field>
        <Field label="GSTIN">
          <Input value={f.gstin ?? ''} onChange={set('gstin')} />
        </Field>
        <Field label="Delivery lead time (days)">
          <Input value={f.lead ?? ''} onChange={set('lead')} inputMode="numeric" />
        </Field>
        <Field label="Address" className="sm:col-span-2">
          <Input value={f.address ?? ''} onChange={set('address')} />
        </Field>
        {!supplier && (
          <Field label="Opening balance (₹ we owe them)">
            <Input value={f.opening ?? ''} onChange={set('opening')} inputMode="decimal" />
          </Field>
        )}
        {supplier && (
          <Field label="Status">
            <Select value={f.active ?? '1'} onChange={set('active')}>
              <option value="1">Active</option>
              <option value="0">Inactive</option>
            </Select>
          </Field>
        )}
        {error && (
          <div className="sm:col-span-2">
            <Notice tone="bad">{error}</Notice>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
