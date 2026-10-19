import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AGE_BUCKETS, formatPaise } from '@kph/core';
import { ApiError, get, post } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useSession } from '../lib/session';
import { Badge, Button, Empty, Field, Input, Modal, Notice, Select, Spinner, Table, cx, useToast } from './ui';

export const money = (p: number) => `₹${formatPaise(p)}`;

export interface CustomerDues {
  customerId: number;
  name: string;
  phone: string | null;
  balancePaise: number;
  creditLimitPaise: number | null;
  creditDays: number;
  buckets: [number, number, number, number];
  overduePaise: number;
  dueTodayPaise: number;
  oldest: { number: string; date: string; days: number } | null;
  nextDueDate: string | null;
  lastReceipt: string | null;
  lastReminder: string | null;
  bills: { id: number | null; number: string; date: string; dueDate: string; totalPaise: number; duePaise: number; days: number; overdue: boolean }[];
}

/**
 * Send a WhatsApp reminder: the server builds the message and logs it; WhatsApp opens with
 * the text filled in (the person still presses Send in WhatsApp).
 */
export function useWhatsAppReminder() {
  const toast = useToast();
  const qc = useQueryClient();
  return async (customerId: number, language?: 'te' | 'en') => {
    // open the window first (inside the click) so the browser doesn't block it as a pop-up
    const w = window.open('', '_blank');
    try {
      const r = await post<{ url: string }>(`/api/customers/${customerId}/reminders`, language ? { language } : {});
      if (w) w.location.href = r.url;
      else window.location.href = r.url;
      void qc.invalidateQueries({ queryKey: ['khata'] });
    } catch (e) {
      w?.close();
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not open WhatsApp' });
    }
  };
}

export function WhatsAppButton({ customerId, disabled, size = 'sm', label = 'WhatsApp' }: { customerId: number; disabled?: boolean; size?: 'sm' | 'md'; label?: string }) {
  const remind = useWhatsAppReminder();
  return (
    <Button size={size} disabled={disabled} onClick={() => void remind(customerId)} title="Send a balance reminder on WhatsApp" aria-label={label || "WhatsApp reminder"}>
      <svg aria-hidden width="15" height="15" viewBox="0 0 24 24" fill="#1d7a3e">
        <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z" />
      </svg>
      {label}
    </Button>
  );
}

/** The khata view of one customer: ageing, open bills with due dates, and the reminder log. */
export function DuesPanel({ customerId }: { customerId: number }) {
  const { can } = useSession();
  const toast = useToast();
  const d = useQuery({ queryKey: ['khata', 'dues', customerId], queryFn: () => get<CustomerDues>(`/api/customers/${customerId}/dues`) });
  const log = useQuery({ queryKey: ['khata', 'reminders', customerId], queryFn: () => get<{ id: number; at: string; channel: string; language: string | null; balance_paise: number; note: string | null; user_name: string }[]>(`/api/customers/${customerId}/reminders`) });
  const [noteOpen, setNoteOpen] = useState(false);
  const [channel, setChannel] = useState<'call' | 'visit' | 'sms'>('call');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const saveNote = async () => {
    setBusy(true);
    try {
      await post(`/api/customers/${customerId}/reminders`, { channel, note });
      setNoteOpen(false);
      setNote('');
      void log.refetch();
    } catch (e) {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  };

  if (!d.data) return <Spinner />;
  const x = d.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <div className={cx('rounded-[4px] px-3 py-2', x.overduePaise > 0 ? 'bg-bad-soft text-bad-ink' : 'bg-concrete')}>
          <div className="text-[11px]">Overdue (over {x.creditDays} days)</div>
          <div className="num text-base font-extrabold">{money(x.overduePaise)}</div>
        </div>
        {AGE_BUCKETS.map((label, i) => (
          <div key={label} className="rounded-[4px] bg-concrete px-3 py-2">
            <div className="text-[11px]">{label}</div>
            <div className="num text-base font-bold">{x.buckets[i] ? money(x.buckets[i]!) : '—'}</div>
          </div>
        ))}
      </div>
      {x.balancePaise < 0 && <Notice tone="teal">They have paid {money(-x.balancePaise)} in advance.</Notice>}
      <div className="overflow-hidden rounded-[6px] border border-line">
        {x.bills.length ? (
          <Table minWidth={520} head={<tr><th>Bill</th><th>Date</th><th>Due by</th><th className="text-right">Bill total</th><th className="text-right">Still due</th></tr>}>
            {x.bills.map((b, i) => (
              <tr key={i}>
                <td className="num font-semibold">{b.number}</td>
                <td className="num">{fmtDate(b.date)} <span className="text-[12px] text-ink-3">({b.days} day{b.days === 1 ? "" : "s"})</span></td>
                <td className="num">{b.overdue ? <Badge tone="bad">overdue · {fmtDate(b.dueDate)}</Badge> : fmtDate(b.dueDate)}</td>
                <td className="num text-right">{money(b.totalPaise)}</td>
                <td className="num text-right font-bold">{money(b.duePaise)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>Nothing due.</Empty>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <b className="flex-1 text-sm">Reminders and calls</b>
        {can('payments.receive') && (
          <Button size="sm" onClick={() => setNoteOpen(true)}>
            Log a call / visit
          </Button>
        )}
      </div>
      {log.data?.length ? (
        <ul className="flex flex-col gap-1 text-[13px]">
          {log.data.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-2">
              <span className="num text-ink-3">{fmtDateTime(r.at)}</span>
              <Badge tone={r.channel === 'whatsapp' ? 'good' : 'neutral'}>{r.channel}</Badge>
              <span>balance {money(r.balance_paise)}</span>
              {r.note && <span className="text-ink-2">· {r.note}</span>}
              <span className="text-ink-3">· {r.user_name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-ink-3">No reminders yet.</p>
      )}
      <Modal open={noteOpen} onClose={() => setNoteOpen(false)} title="Log a call or visit" footer={<><Button variant="ghost" onClick={() => setNoteOpen(false)}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void saveNote()}>Save</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="How">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
              <option value="call">Phone call</option>
              <option value="visit">Visit</option>
              <option value="sms">SMS</option>
            </Select>
          </Field>
          <Field label="What they said">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. will pay ₹10,000 on Friday" autoFocus />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
