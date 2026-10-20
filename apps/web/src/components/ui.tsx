import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };
import { useLang } from '../lib/i18n';

// ---------------------------------------------------------------- logo

/** The house mark: brick roof with a paint drip, ink bricks, cement base. Never recoloured or rearranged. */
export function LogoMark({ size = 40, reversed = false, title }: { size?: number; reversed?: boolean; title?: string }) {
  const brick = reversed ? '#F3F1EC' : '#16181B';
  return (
    <svg width={size} height={size * 0.83} viewBox="0 0 120 100" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <polygon points="10,44 60,8 110,44" fill="#C2491A" />
      <rect x="76" y="40" width="8" height="16" rx="4" fill="#C2491A" />
      <rect x="18" y="48" width="38" height="14" fill={brick} />
      <rect x="60" y="48" width="12" height="14" fill={brick} />
      <rect x="88" y="48" width="14" height="14" fill={brick} />
      <rect x="18" y="66" width="18" height="14" fill={brick} />
      <rect x="40" y="66" width="40" height="14" fill={brick} />
      <rect x="84" y="66" width="18" height="14" fill={brick} />
      <rect x="10" y="84" width="100" height="12" fill="#8A857C" />
    </svg>
  );
}

export function Logo({ reversed = false, size = 40, word = 21 }: { reversed?: boolean; size?: number; word?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} reversed={reversed} title="Kanakapatnam Paints and Hardwares" />
      <span className="flex flex-col leading-[1.02]">
        <span className="font-extrabold tracking-[.02em]" style={{ fontSize: word, fontStretch: '75%' }}>
          KANAKAPATNAM
        </span>
        <span className={cx('font-semibold tracking-[.3em]', reversed ? 'text-nav' : 'text-ink-2')} style={{ fontSize: Math.max(8, word * 0.38) }}>
          PAINTS &amp; HARDWARES
        </span>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- buttons & inputs

type Variant = 'primary' | 'dark' | 'teal' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brick text-white hover:bg-brick-dark disabled:bg-brick-soft font-bold',
  dark: 'bg-ink text-white hover:bg-black disabled:bg-cement font-bold',
  teal: 'bg-teal text-white hover:brightness-110 disabled:opacity-50 font-bold',
  secondary: 'bg-white border border-line-2 text-ink hover:bg-paper disabled:opacity-50 font-semibold',
  ghost: 'text-ink hover:bg-paper disabled:opacity-50 font-semibold',
  danger: 'bg-white border border-line-2 text-bad hover:bg-bad-soft disabled:opacity-50 font-semibold',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; busy?: boolean }) {
  const s = size === 'sm' ? 'h-8 px-2.5 text-[13px]' : size === 'lg' ? 'h-14 px-5 text-lg' : 'h-10 px-4 text-sm';
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={cx('inline-flex items-center justify-center gap-2 rounded-[6px] cursor-pointer disabled:cursor-not-allowed transition-colors', s, VARIANTS[variant], className)}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cx('inline-block size-4 rounded-full border-2 border-current border-r-transparent animate-spin', className)} />;
}

export const inputCls =
  'h-10 w-full rounded-[6px] border border-line-2 bg-white px-3 text-sm text-ink placeholder:text-cement focus:border-teal focus:outline-none focus:ring-4 focus:ring-teal-soft disabled:bg-paper';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(inputCls, className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(inputCls, 'pr-8', className)}>
      {children}
    </select>
  );
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col gap-1', className)}>
      <span className="text-[13px] font-bold">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-ink-3">{hint}</span>}
      {error && <span className="text-xs text-bad">{error}</span>}
    </label>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
      <input type="checkbox" className="size-4 accent-teal" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------- layout bits

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-[6px] border border-line bg-white', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
          {title && <h2 className="headline text-lg">{title}</h2>}
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageTitle({ title, telugu, actions, sub }: { title: string; telugu?: string; actions?: ReactNode; sub?: ReactNode }) {
  // Telugu screens: the Telugu name is the main title, English underneath.
  const te = useLang() === 'te' && !!telugu;
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        {te ? <span className="text-[13px] font-bold uppercase tracking-[.14em] text-brick">{title}</span> : telugu && <span className="telugu text-[15px] font-semibold text-brick">{telugu}</span>}
        <h1 className={te ? 'telugu text-[32px] font-bold leading-tight sm:text-[36px]' : 'headline text-[34px] sm:text-[38px]'}>{te ? telugu : title}</h1>
        {sub && <div className="text-sm text-ink-3">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'teal';
const TONES: Record<Tone, string> = {
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn-ink',
  bad: 'bg-bad-soft text-bad-ink',
  neutral: 'bg-concrete text-ink-2',
  teal: 'bg-teal-soft text-teal',
};
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-[3px] px-1.5 py-px text-[11px] font-bold whitespace-nowrap', TONES[tone])}>{children}</span>;
}

export function Notice({ tone = 'neutral', children, icon = true }: { tone?: Tone; children: ReactNode; icon?: boolean }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cx('flex gap-2 rounded-[6px] px-3 py-2.5 text-[13px]', TONES[tone])}>
      {icon && (
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-px flex-none">
          {tone === 'good' ? <path d="M20 6 9 17l-5-5" /> : <><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></>}
        </svg>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-ink-3">{children}</div>;
}

/** Table shell with brand header styling and horizontal scroll on small screens. */
export function Table({ head, children, minWidth = 720 }: { head: ReactNode; children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        <thead className="bg-paper text-left [&_th]:border-b [&_th]:border-line [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-[11px] [&_th]:font-bold [&_th]:uppercase [&_th]:tracking-[.12em] [&_th]:text-ink-3 [&_th]:whitespace-nowrap">
          {head}
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-line-3 [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-middle">{children}</tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- modal

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
  dark = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  dark?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    // React's autoFocus focuses its field itself; only pick the first field when nothing inside is focused.
    const t = setTimeout(() => {
      if (ref.current && !ref.current.contains(document.activeElement)) ref.current.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto bg-ink/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" className="w-full rounded-[6px] bg-white shadow-2xl overflow-hidden my-8" style={{ maxWidth: width }}>
        <div className={cx('flex items-center justify-between gap-3 px-5 py-4', dark ? 'bg-ink text-white' : 'border-b border-line')}>
          <h2 className="headline text-xl">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className={cx('size-8 rounded-[4px] grid place-items-center', dark ? 'hover:bg-white/10' : 'hover:bg-paper')}>
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-paper px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** "Type X to confirm" for things that cannot be undone easily. */
export function ConfirmTyped({
  open,
  onClose,
  title,
  word,
  children,
  onConfirm,
  busy,
  confirmLabel = 'Confirm',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  word: string;
  children: ReactNode;
  onConfirm: () => void;
  busy?: boolean;
  confirmLabel?: string;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => setTyped(''), [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="dark" disabled={typed !== word} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {children}
        <Field label={<>Type <b className="font-mono">{word}</b> to confirm</>}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- toasts

type Toast = { id: number; tone: Tone; text: ReactNode; action?: { label: string; onClick: () => void } };
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-3), { ...t, id }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), t.tone === 'bad' ? 9000 : 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="no-print fixed bottom-4 right-4 z-[60] flex w-[min(420px,calc(100vw-32px))] flex-col gap-2">
        {list.map((t) => (
          <div key={t.id} className={cx('flex items-start gap-3 rounded-[6px] px-4 py-3 text-sm shadow-lg border', t.tone === 'bad' ? 'bg-bad-soft text-bad-ink border-bad/30' : t.tone === 'good' ? 'bg-white text-ink border-good/40' : 'bg-white text-ink border-line')}>
            {t.tone === 'good' && <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1d7a3e" strokeWidth="2.5" className="mt-0.5 flex-none"><path d="M20 6 9 17l-5-5" /></svg>}
            <div className="flex-1 min-w-0">{t.text}</div>
            {t.action && (
              <button type="button" className="font-bold underline" onClick={t.action.onClick}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function SampleBanner() {
  return (
    <div className="no-print flex items-center gap-2.5 bg-sample px-5 py-1.5 text-[13px] font-semibold text-ink">
      <span className="rounded-[3px] bg-ink px-2 py-px text-[11px] font-extrabold tracking-[.14em] text-sample">SAMPLE DATA</span>
      Practice workspace — bills made here are not real and never reach the books.
    </div>
  );
}
