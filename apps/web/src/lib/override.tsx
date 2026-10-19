import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import type { Permission } from '@kph/core';
import { Button, Field, Input, Notice, Select } from '../components/ui';
import { Modal } from '../components/ui';
import { ApiError, post } from './api';
import { useSession } from './session';

/**
 * Admin PIN approval. A screen asks for approval of ONE specific action; an admin
 * enters their PIN on the same computer; the server hands back a single-use token
 * that only works for that action, for 5 minutes.
 */
export interface OverrideRequest {
  permission: Permission;
  context: Record<string, unknown>;
  title: string;
  details: ReactNode;
}
export interface OverrideResult {
  token: string;
  approvedBy: { id: number; name: string };
}

const Ctx = createContext<(r: OverrideRequest) => Promise<OverrideResult | null>>(async () => null);
export const useOverride = () => useContext(Ctx);

export function OverrideProvider({ children }: { children: ReactNode }) {
  const { boot, user } = useSession();
  const [req, setReq] = useState<OverrideRequest | null>(null);
  const resolver = useRef<(r: OverrideResult | null) => void>(() => {});
  const [approverId, setApproverId] = useState<number | null>(null);
  const [pin, setPin] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const admins = (boot?.users ?? []).filter((u) => u.role_id === 'admin' && u.id !== user?.userId);
  const allAdmins = (boot?.users ?? []).filter((u) => u.role_id === 'admin');
  const approvers = admins.length ? admins : allAdmins;

  const request = useCallback(
    (r: OverrideRequest) =>
      new Promise<OverrideResult | null>((resolve) => {
        resolver.current = resolve;
        setReq(r);
        setPin('');
        setNote('');
        setError(null);
        setApproverId(null);
      }),
    [],
  );

  const close = (result: OverrideResult | null) => {
    resolver.current(result);
    setReq(null);
  };

  const submit = async () => {
    if (!req) return;
    const id = approverId ?? approvers[0]?.id;
    if (!id) return setError('No admin user exists to approve this.');
    setBusy(true);
    setError(null);
    try {
      const r = await post<OverrideResult>('/api/auth/override', { permission: req.permission, approverId: id, pin, context: req.context, reason: note || undefined });
      close(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not approve');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Ctx.Provider value={request}>
      {children}
      <Modal
        open={!!req}
        onClose={() => close(null)}
        title="Admin approval needed"
        dark
        width={480}
        footer={
          <>
            <Button onClick={() => close(null)}>Cancel</Button>
            <Button variant="primary" busy={busy} disabled={pin.length < 4} onClick={submit}>
              APPROVE
            </Button>
          </>
        }
      >
        {req && (
          <form
            className="flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="rounded-[4px] bg-warn-soft p-3 text-sm">
              <div className="font-bold">{req.title}</div>
              <div className="text-ink-2">
                asked by {user?.userName} · {boot?.device?.name}
              </div>
              <div className="mt-1 text-ink-2">{req.details}</div>
            </div>
            <Field label="Approver">
              <Select value={approverId ?? approvers[0]?.id ?? ''} onChange={(e) => setApproverId(Number(e.target.value))}>
                {approvers.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role_name})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Admin PIN">
              <Input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                className="h-12 text-center text-2xl tracking-[.4em]"
              />
            </Field>
            <Field label="Note (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. regular painter, bulk order" />
            </Field>
            {error && <Notice tone="bad">{error}</Notice>}
            <p className="text-xs text-ink-3">Approval works once, for this action only, for 5 minutes. It is recorded in the activity log and shown on the owner dashboard.</p>
            <button type="submit" hidden />
          </form>
        )}
      </Modal>
    </Ctx.Provider>
  );
}
