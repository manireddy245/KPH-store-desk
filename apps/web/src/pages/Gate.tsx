import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, post, store } from '../lib/api';
import { useSession, type Tile } from '../lib/session';
import { Button, Field, Input, Logo, Notice, SampleBanner, Spinner, cx } from '../components/ui';

/** Everything before someone is logged in on an approved counter. */
export function Gate() {
  const { phase } = useSession();
  if (phase === 'loading')
    return (
      <Shell>
        <div className="flex items-center justify-center gap-3 p-10 text-ink-3">
          <Spinner /> Connecting to the shop server…
        </div>
      </Shell>
    );
  if (phase === 'offline') return <Offline />;
  if (phase === 'setup') return <Setup />;
  if (phase === 'register') return <Register />;
  if (phase === 'pending') return <Pending />;
  if (phase === 'revoked')
    return (
      <Shell>
        <div className="p-8">
          <Notice tone="bad">This computer has been blocked by admin. Ask the owner to allow it again in Settings → Counters.</Notice>
        </div>
      </Shell>
    );
  return <Login />;
}

function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { boot } = useSession();
  return (
    <div className="flex min-h-screen flex-col bg-ink">
      {boot?.workspace === 'sample' && <SampleBanner />}
      <main className="flex flex-1 flex-col items-center justify-center gap-7 px-4 py-8">
        <div className="text-white">
          <Logo reversed size={64} word={34} />
        </div>
        <div className={cx('w-full overflow-hidden rounded-[6px] bg-white shadow-2xl', wide ? 'max-w-[820px]' : 'max-w-[480px]')}>{children}</div>
      </main>
    </div>
  );
}

function Offline() {
  return (
    <Shell>
      <div className="flex flex-col gap-3 p-7">
        <h1 className="headline text-2xl">Can't reach the shop server</h1>
        <p className="text-sm text-ink-2">
          Check that the server computer is switched on and this computer is on the shop Wi-Fi or cable. This page tries again every few seconds.
        </p>
        <div className="flex items-center gap-2 text-sm text-ink-3">
          <Spinner /> Retrying…
        </div>
      </div>
    </Shell>
  );
}

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Setup() {
  const { reload } = useSession();
  const [storeName, setStoreName] = useState('Kanakapatnam Paints and Hardwares');
  const [adminName, setAdminName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [deviceName, setDeviceName] = useState('Office');
  const { busy, error, run } = useAsync();
  const valid = adminName.trim().length >= 2 && /^\d{4,8}$/.test(pin) && pin === pin2 && deviceName.trim().length >= 2;
  return (
    <Shell>
      <form
        className="flex flex-col gap-4 p-7"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await post<{ deviceToken: string; token: string }>('/api/setup', { storeName, adminName, pin, deviceName });
            store.deviceToken = r.deviceToken;
            store.sessionToken = r.token;
            await reload();
          });
        }}
      >
        <div>
          <div className="eyebrow">First-time setup</div>
          <h1 className="headline text-3xl">Set up the shop</h1>
          <p className="mt-1 text-sm text-ink-3">This creates the owner (admin) account and registers this computer.</p>
        </div>
        <Field label="Shop name">
          <Input value={storeName} onChange={(e) => setStoreName(e.target.value)} />
        </Field>
        <Field label="Owner / admin name">
          <Input value={adminName} onChange={(e) => setAdminName(e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Admin PIN (4–8 digits)">
            <Input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} />
          </Field>
          <Field label="PIN again" error={pin2 && pin !== pin2 ? 'PINs do not match' : undefined}>
            <Input type="password" inputMode="numeric" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, '').slice(0, 8))} />
          </Field>
        </div>
        <Field label="Name of this computer" hint='e.g. "Office", "Counter 1"'>
          <Input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" variant="primary" size="lg" disabled={!valid} busy={busy}>
          CREATE SHOP
        </Button>
      </form>
    </Shell>
  );
}

function Register() {
  const { reload } = useSession();
  const [name, setName] = useState('');
  const { busy, error, run } = useAsync();
  return (
    <Shell>
      <form
        className="flex flex-col gap-4 p-7"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await post<{ token: string }>('/api/devices/register', { name });
            store.deviceToken = r.token;
            await reload();
          });
        }}
      >
        <div>
          <div className="eyebrow">New computer</div>
          <h1 className="headline text-3xl">Register this computer</h1>
          <p className="mt-1 text-sm text-ink-3">Give it the name of its counter. Every bill made here carries this name. An admin approves it once.</p>
        </div>
        <Field label="Counter name" hint='e.g. "Counter 1", "Counter 2", "Office", "Guru phone"'>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" variant="primary" size="lg" disabled={name.trim().length < 2} busy={busy}>
          REGISTER
        </Button>
      </form>
    </Shell>
  );
}

function Pending() {
  const { boot, reload } = useSession();
  const approvers = boot?.approvers ?? [];
  const [approverId, setApproverId] = useState<number | null>(approvers[0]?.id ?? null);
  const [pin, setPin] = useState('');
  const { busy, error, run } = useAsync();
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [reload]);
  return (
    <Shell>
      <form
        className="flex flex-col gap-4 p-7"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await post('/api/devices/approve-here', { approverId, pin });
            await reload();
          });
        }}
      >
        <div>
          <div className="eyebrow">Waiting for approval</div>
          <h1 className="headline text-3xl">“{boot?.device?.name}” needs approval</h1>
          <p className="mt-1 text-sm text-ink-3">The owner can approve it from Settings → Counters on another computer, or right here with the admin PIN.</p>
        </div>
        {approvers.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2">
              {approvers.map((a) => (
                <UserTile key={a.id} user={a} selected={approverId === a.id} onClick={() => setApproverId(a.id)} />
              ))}
            </div>
            <Field label="Admin PIN">
              <Input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} autoFocus />
            </Field>
          </>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
        <Button type="submit" variant="primary" disabled={!approverId || pin.length < 4} busy={busy}>
          APPROVE THIS COMPUTER
        </Button>
      </form>
    </Shell>
  );
}

const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function UserTile({ user, selected, onClick, sub }: { user: Tile; selected: boolean; onClick: () => void; sub?: string }) {
  const color = user.role_id === 'admin' ? 'bg-ink' : user.role_id === 'stock' ? 'bg-cement' : 'bg-teal';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cx(
        'flex h-[60px] w-full items-center gap-3 rounded-[6px] px-3.5 text-left',
        selected ? 'border-2 border-teal bg-teal-soft' : 'border border-line bg-white hover:bg-paper',
      )}
    >
      <span className={cx('grid size-9 flex-none place-items-center rounded-full font-extrabold text-white', color)}>{initials(user.name)}</span>
      <span className="flex min-w-0 flex-col">
        <b className="truncate text-[15px]">{user.name}</b>
        <span className="text-xs text-ink-3">{sub ?? user.role_name}</span>
      </span>
    </button>
  );
}

function Login() {
  const { boot, lastUserId, loginWith } = useSession();
  const users = boot?.users ?? [];
  const [selected, setSelected] = useState<number | null>(lastUserId ?? (users.length === 1 ? users[0]!.id : null));
  const [pin, setPin] = useState('');
  const { busy, error, run } = useAsync();
  const pinRef = useRef<HTMLInputElement>(null);
  const sel = users.find((u) => u.id === selected);

  useEffect(() => {
    pinRef.current?.focus();
  }, [selected]);

  const submit = () =>
    selected &&
    pin.length >= 4 &&
    run(async () => {
      try {
        await loginWith(selected, pin);
      } finally {
        setPin('');
      }
    });

  const press = (d: string) => setPin((p) => (p + d).slice(0, 8));

  return (
    <Shell wide>
      <div className="flex flex-wrap">
        <section className="flex flex-[1_1_340px] flex-col gap-4 bg-concrete p-7">
          <div className="eyebrow">
            Store Desk · this computer: <span className="text-ink">{boot?.device?.name}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="telugu text-[15px] font-semibold text-brick">ఎవరు బిల్ చేస్తున్నారు?</span>
            <h1 className="headline text-3xl">Who is billing?</h1>
          </div>
          <div role="radiogroup" aria-label="Choose user" className="flex flex-col gap-2">
            {users.map((u) => (
              <UserTile key={u.id} user={u} selected={selected === u.id} onClick={() => setSelected(u.id)} sub={u.id === lastUserId ? `${u.role_name} · was using this counter` : undefined} />
            ))}
          </div>
          <p className="mt-auto text-xs text-ink-3">Locks after {boot?.settings.idleLockMinutes ?? 5} minutes without use. Half-made bills are kept for each person.</p>
        </section>
        <form
          className="flex flex-[1_1_340px] flex-col gap-3.5 p-7"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2 className="headline text-[22px]">{sel ? `${sel.name}, enter your PIN` : 'Choose your name'}</h2>
          <label className="sr-only" htmlFor="pin">
            PIN
          </label>
          <input
            id="pin"
            ref={pinRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            disabled={!sel}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
            className="h-14 rounded-[6px] border-2 border-teal text-center text-[28px] tracking-[.5em] outline-none disabled:border-line disabled:bg-paper"
          />
          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <PadKey key={d} onClick={() => press(d)} disabled={!sel}>
                {d}
              </PadKey>
            ))}
            <PadKey onClick={() => setPin('')} disabled={!sel} small>
              Clear
            </PadKey>
            <PadKey onClick={() => press('0')} disabled={!sel}>
              0
            </PadKey>
            <button type="submit" disabled={!sel || pin.length < 4 || busy} className="h-14 rounded-[6px] bg-brick text-base font-extrabold tracking-[.06em] text-white hover:bg-brick-dark disabled:bg-brick-soft">
              {busy ? <Spinner /> : 'OPEN'}
            </button>
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
          <p className="text-center text-xs text-ink-3">Type on the keyboard or tap the keys · Enter to open</p>
        </form>
      </div>
    </Shell>
  );
}

function PadKey({ children, onClick, disabled, small }: { children: ReactNode; onClick: () => void; disabled?: boolean; small?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cx('h-14 rounded-[6px] border border-line bg-white font-bold hover:bg-concrete disabled:opacity-40', small ? 'text-[15px] text-ink-3' : 'text-[22px]')}>
      {children}
    </button>
  );
}
