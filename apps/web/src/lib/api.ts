/**
 * Talks to the Store Desk server. Every request carries this computer's device
 * token (which counter it is) and, once logged in, the session token.
 * Device tokens are kept per workspace, because sample and real data are
 * separate databases with separate registered counters.
 */

const LS = {
  workspace: 'kph.workspace',
  device: (ws: string) => `kph.deviceToken.${ws}`,
  session: (ws: string) => `kph.session.${ws}`,
};

function ls(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, v: string | null) {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* storage blocked: still works until reload */
  }
}

export const store = {
  get workspace() {
    return ls(LS.workspace) ?? 'sample';
  },
  set workspace(ws: string) {
    lsSet(LS.workspace, ws);
  },
  get deviceToken() {
    return ls(LS.device(this.workspace));
  },
  set deviceToken(t: string | null) {
    lsSet(LS.device(this.workspace), t);
  },
  get sessionToken() {
    // Session lives in sessionStorage-like scope per workspace; cleared on lock.
    return ls(LS.session(this.workspace));
  },
  set sessionToken(t: string | null) {
    lsSet(LS.session(this.workspace), t);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

type Listener = (e: ApiError) => void;
const authListeners = new Set<Listener>();
export function onAuthError(l: Listener) {
  authListeners.add(l);
  return () => authListeners.delete(l);
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (store.deviceToken) headers['x-device-token'] = store.deviceToken;
  if (store.sessionToken) headers.authorization = `Bearer ${store.sessionToken}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'OFFLINE', 'Cannot reach the shop server. Check the Wi-Fi/LAN cable and that the server computer is on. Your bill is kept.');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data?.code ?? 'ERROR', data?.message ?? `Request failed (${res.status})`, data?.details);
    if (['NOT_LOGGED_IN', 'DEVICE_UNKNOWN', 'DEVICE_NOT_APPROVED'].includes(err.code)) authListeners.forEach((l) => l(err));
    throw err;
  }
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return { message: t };
  }
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
