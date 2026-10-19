import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@kph/core';
import { ApiError, get, onAuthError, post, store } from './api';

export interface Tile {
  id: number;
  name: string;
  role_id: string;
  role_name: string;
}

export interface Boot {
  workspace: 'sample' | 'live';
  setupNeeded: boolean;
  store: { name: string };
  device: { id: number; name: string; status: 'pending' | 'approved' | 'revoked' } | null;
  users: Tile[];
  approvers: Tile[];
  settings: { idleLockMinutes: number; discountHintEnabled: boolean; salesPriceMode: 'excl' | 'incl'; purchasePriceMode: 'excl' | 'incl'; stateCode: string };
  session: SessionUser | null;
}

export interface SessionUser {
  userId: number;
  userName: string;
  roleId: string;
  permissions: string[];
  language: string;
  discountCapBp: number | null;
  deviceId: number;
}

type Phase = 'loading' | 'offline' | 'setup' | 'register' | 'pending' | 'revoked' | 'login' | 'ready';

interface Ctx {
  phase: Phase;
  boot: Boot | null;
  user: SessionUser | null;
  /** The person who was using this counter before it locked (pre-selected on the login screen). */
  lastUserId: number | null;
  can: (p: Permission) => boolean;
  reload: () => Promise<void>;
  loginWith: (userId: number, pin: string) => Promise<void>;
  lock: () => Promise<void>;
  setDeviceToken: (t: string) => void;
  setSession: (token: string, user: SessionUser) => void;
}

const SessionCtx = createContext<Ctx>(null as unknown as Ctx);
export const useSession = () => useContext(SessionCtx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [boot, setBoot] = useState<Boot | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const [lastUserId, setLastUserId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      let b = await get<Boot>('/api/bootstrap');
      if (b.workspace !== store.workspace) {
        // The server switched between sample and real data: use that workspace's counter token.
        store.workspace = b.workspace;
        b = await get<Boot>('/api/bootstrap');
      }
      setBoot(b);
      if (b.setupNeeded && (!b.device || b.device.status !== 'approved')) return setPhase('setup');
      if (!b.device) return setPhase('register');
      if (b.device.status === 'pending') return setPhase('pending');
      if (b.device.status === 'revoked') return setPhase('revoked');
      if (b.session) {
        setUser(b.session);
        setPhase('ready');
      } else {
        store.sessionToken = null;
        setUser(null);
        setPhase('login');
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'OFFLINE') setPhase('offline');
      else throw e;
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // Retry automatically while the server can't be reached.
  useEffect(() => {
    if (phase !== 'offline') return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [phase, reload]);

  useEffect(() => {
    const off = onAuthError(() => void reload());
    return () => {
      off();
    };
  }, [reload]);

  const loginWith = useCallback(
    async (userId: number, pin: string) => {
      const r = await post<{ token: string; session: SessionUser }>('/api/auth/login', { userId, pin });
      store.sessionToken = r.token;
      setUser(r.session);
      setLastUserId(r.session.userId);
      qc.clear();
      setPhase('ready');
    },
    [qc],
  );

  const setSession = useCallback((token: string, u: SessionUser) => {
    store.sessionToken = token;
    setUser(u);
    setLastUserId(u.userId);
    setPhase('ready');
  }, []);

  const lock = useCallback(async () => {
    if (user) setLastUserId(user.userId);
    try {
      if (store.sessionToken) await post('/api/auth/logout', { lock: true });
    } catch {
      /* already ended */
    }
    store.sessionToken = null;
    setUser(null);
    qc.clear();
    await reload();
  }, [user, qc, reload]);

  // Auto-lock after the configured idle time.
  const idleMs = (boot?.settings.idleLockMinutes ?? 5) * 60_000;
  const lastActive = useRef(Date.now());
  useEffect(() => {
    if (phase !== 'ready') return;
    const mark = () => (lastActive.current = Date.now());
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - lastActive.current > idleMs) void lock();
    }, 10_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, mark));
      clearInterval(t);
    };
  }, [phase, idleMs, lock]);

  // Ctrl+L: lock / switch user, anywhere.
  useEffect(() => {
    if (phase !== 'ready') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        void lock();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, lock]);

  // Live updates from other counters.
  useEffect(() => {
    if (phase !== 'ready' || !store.sessionToken || !store.deviceToken) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 1000;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(store.sessionToken!)}&device=${encodeURIComponent(store.deviceToken!)}`);
      ws.onopen = () => (retry = 1000);
      ws.onmessage = (m) => {
        const e = JSON.parse(m.data) as { type: string };
        if (e.type === 'workspace.changed') return void location.reload();
        const keys: Record<string, string[]> = {
          'invoice.created': ['invoices', 'dashboard', 'products', 'customers'],
          'invoice.cancelled': ['invoices', 'dashboard', 'products', 'customers', 'invoice'],
          'receipt.created': ['receipts', 'customers', 'customer', 'dashboard'],
          'receipt.cancelled': ['receipts', 'customers', 'customer', 'dashboard'],
          'stock.changed': ['products', 'dashboard', 'movements'],
          'products.changed': ['products', 'categories', 'dashboard'],
          'customers.changed': ['customers', 'customer'],
          'suppliers.changed': ['suppliers'],
          'settings.changed': ['settings'],
          'users.changed': ['users', 'roles'],
          'devices.changed': ['devices'],
        };
        for (const k of keys[e.type] ?? []) void qc.invalidateQueries({ queryKey: [k] });
        if (e.type === 'settings.changed') void reload();
      };
      ws.onclose = () => {
        if (stopped) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
    };
    connect();
    return () => {
      stopped = true;
      ws?.close();
    };
  }, [phase, qc, reload]);

  const value = useMemo<Ctx>(
    () => ({
      phase,
      boot,
      user,
      lastUserId,
      can: (p) => !!user?.permissions.includes(p),
      reload,
      loginWith,
      lock,
      setDeviceToken: (t) => (store.deviceToken = t),
      setSession,
    }),
    [phase, boot, user, lastUserId, reload, loginWith, lock, setSession],
  );
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}
