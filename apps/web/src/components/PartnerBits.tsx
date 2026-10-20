import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../lib/api';
import { Select, useDebounced } from './ui';
import { useT } from '../lib/i18n';

export interface PartnerPick {
  id: number;
  name: string;
  type_name: string;
}

export interface PartnerRow {
  id: number;
  name: string;
  phone: string | null;
  area: string | null;
  type_id: number;
  type_name: string;
  joined_on: string;
  active: boolean;
  customer_id: number | null;
  language: string | null;
  notes: string | null;
  bills: number;
  sales_paise: number;
  last_bill: string | null;
  reward_balance_paise: number;
  days_since: number | null;
}

/** "Brought by" on the billing screen: the painter / mason / contractor who sent this customer, and their site. */
export function PartnerPicker({ partner, siteId, onChange }: { partner: PartnerPick | null; siteId: number | null; onChange: (p: PartnerPick | null, siteId: number | null) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 200);
  const results = useQuery({ queryKey: ['partners', 'search', dq], queryFn: () => get<PartnerRow[]>(`/api/partners${qs({ search: dq })}`), enabled: dq.trim().length >= 2 });
  const t = useT();
  const sites = useQuery({
    queryKey: ['partners', 'sites', partner?.id],
    queryFn: async () => (await get<{ sites: { id: number; name: string; active: boolean }[] }>(`/api/partners/${partner!.id}`)).sites.filter((s) => s.active),
    enabled: !!partner,
  });

  return (
    <div className="flex flex-col gap-2 rounded-[6px] border border-line bg-white px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="eyebrow">{t('Brought by (painter, mason…)')}</span>
        {partner && (
          <button type="button" onClick={() => onChange(null, null)} className="h-[28px] rounded-[6px] border border-line-2 px-2 text-[12px] font-semibold hover:bg-paper">
            Remove
          </button>
        )}
      </div>
      {partner ? (
        <>
          <div className="text-sm">
            <b>{partner.name}</b> <span className="text-ink-3">· {partner.type_name}</span>
          </div>
          {(sites.data?.length ?? 0) > 0 && (
            <Select aria-label="Site" value={siteId ?? ''} onChange={(e) => onChange(partner, e.target.value ? Number(e.target.value) : null)}>
              <option value="">Site (optional)</option>
              {sites.data!.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </>
      ) : (
        <div className="relative">
          <input
            aria-label="Find partner by name or phone"
            placeholder="Optional: find painter / mason…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 w-full rounded-[6px] border border-line-2 px-3 text-sm outline-none focus:border-teal focus:ring-4 focus:ring-teal-soft"
          />
          {q.trim().length >= 2 && (
            <div className="absolute inset-x-0 top-10 z-20 max-h-64 overflow-auto rounded-[6px] border border-line bg-white shadow-xl">
              {(results.data ?? []).map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => {
                    onChange({ id: p.id, name: p.name, type_name: p.type_name }, null);
                    setQ('');
                  }}
                  className="flex w-full items-center justify-between gap-2 border-t border-line-3 px-3 py-2 text-left first:border-t-0 hover:bg-teal-soft"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{p.name}</span>
                    <span className="block text-xs text-ink-3">
                      {p.type_name}
                      {p.phone ? ` · ${p.phone}` : ''}
                      {p.area ? ` · ${p.area}` : ''}
                    </span>
                  </span>
                </button>
              ))}
              {results.data?.length === 0 && <div className="px-3 py-2.5 text-sm text-ink-3">No partner found. Add them in Partners.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
