import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post, store } from '../lib/api';
import { formatPaise, formatQty, fmtTime, MODE_LABEL, uuid } from '../lib/format';
import { preparePage } from '../lib/images';
import { useSession } from '../lib/session';
import type { AssistantCard, AssistantMessage } from '../lib/types';
import { Badge, Button, Notice, Spinner, cx, useToast } from '../components/ui';

/**
 * The shop assistant. Type, attach photos (supplier bills, a customer's list) or record
 * a voice note in Telugu or English. Answers may carry cards; nothing is saved until
 * someone presses the button on a card.
 */

interface Pending {
  key: string;
  kind: 'image' | 'pdf' | 'audio';
  mimeType: string;
  base64: string;
  previewUrl: string;
  name: string;
}

const EXAMPLES = ['Today\'s sales?', 'Which items are running low?', '20 bags PPC cement for Reddy on credit', 'How much does Ravi Constructions owe?'];

export function Assistant() {
  const qc = useQueryClient();
  const toast = useToast();
  const { boot } = useSession();
  const messages = useQuery({ queryKey: ['assistant'], queryFn: () => get<AssistantMessage[]>('/api/assistant/messages') });
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [optimistic, setOptimistic] = useState<{ text: string; files: Pending[] } | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);

  const send = useMutation({
    mutationFn: (b: { text: string; files: Pending[] }) =>
      post<{ messages: AssistantMessage[] }>('/api/assistant/messages', { text: b.text, files: b.files.map((f) => ({ mimeType: f.mimeType, base64: f.base64 })) }),
    onMutate: (b) => {
      setOptimistic(b);
      setText('');
      setFiles([]);
    },
    onSuccess: (r) => qc.setQueryData<AssistantMessage[]>(['assistant'], (old) => [...(old ?? []), ...r.messages]),
    onError: (e, b) => {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not send. Check the connection.' });
      setText(b.text);
      setFiles(b.files);
    },
    onSettled: () => setOptimistic(null),
  });

  const retry = useMutation({
    mutationFn: (failedId: number) => post<{ messages: AssistantMessage[] }>(`/api/assistant/messages/${failedId}/retry`),
    onSuccess: (r, failedId) =>
      qc.setQueryData<AssistantMessage[]>(['assistant'], (old) => [...(old ?? []).filter((m) => m.id !== failedId && m.id !== r.messages[0]!.id), ...r.messages]),
    onError: (e) => toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not try again. Check the connection.' }),
  });

  const clear = useMutation({
    mutationFn: () => post('/api/assistant/clear'),
    onSuccess: () => qc.setQueryData(['assistant'], []),
  });

  useEffect(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }, [messages.data?.length, optimistic]);

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const next = [...files];
    for (const f of Array.from(list)) {
      if (next.length >= 6) break;
      if (f.type.startsWith('audio/')) {
        next.push({ key: uuid(), kind: 'audio', mimeType: f.type, base64: await toBase64(f), previewUrl: URL.createObjectURL(f), name: f.name });
      } else {
        const p = await preparePage(f);
        next.push({ key: uuid(), kind: p.mimeType === 'application/pdf' ? 'pdf' : 'image', mimeType: p.mimeType, base64: p.base64, previewUrl: p.previewUrl, name: p.name });
      }
    }
    setFiles(next);
  };

  const submit = (override?: { text?: string; files?: Pending[] }) => {
    const b = { text: (override?.text ?? text).trim(), files: override?.files ?? files };
    if ((!b.text && !b.files.length) || send.isPending) return;
    send.mutate(b);
  };

  const noKey = boot?.settings.hasGeminiKey === false;
  const list = messages.data ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-1 flex-col">
      <div className="flex items-end gap-3 border-b border-line px-4 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="telugu text-[13px] text-ink-3">సహాయకుడు</div>
          <h1 className="headline text-[26px] leading-none">Assistant</h1>
        </div>
        {list.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => clear.mutate()} busy={clear.isPending}>
            Clear chat
          </Button>
        )}
      </div>

      <div className="flex-1 px-3 py-4 sm:px-4" aria-live="polite">
        {messages.isLoading && (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        )}
        {!messages.isLoading && !list.length && !optimistic && (
          <div className="mx-auto max-w-[520px] py-6 text-center">
            <p className="text-[15px] text-ink-2">
              Ask about stock, sales or a customer's balance. Send a <b>photo of a supplier bill</b> to enter the purchase, or record a <b>voice note</b> in Telugu or English.
            </p>
            <p className="mt-2 text-[13px] text-ink-3">Nothing is saved until you press the button on a card.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((e) => (
                <button key={e} type="button" onClick={() => submit({ text: e, files: [] })} className="rounded-full border border-line-2 bg-white px-3 py-1.5 text-[13px] hover:bg-paper">
                  {e}
                </button>
              ))}
            </div>
            {noKey && <div className="mt-4"><Notice tone="warn">The assistant needs a Gemini API key — admin can add it in Settings → Shop & billing.</Notice></div>}
          </div>
        )}
        <div className="flex flex-col gap-3">
          {list.map((m, i) => (
            <Bubble key={m.id} m={m} onRetry={i === list.length - 1 && m.error && !send.isPending ? () => retry.mutate(m.id) : undefined} retrying={retry.isPending} />
          ))}
          {retry.isPending && (
            <div className="flex items-center gap-2 self-start rounded-[10px] bg-white px-3 py-2.5 text-[13px] text-ink-3 shadow-[0_0_0_1px_var(--color-line)]">
              <Spinner /> Trying again… (Google is busy, this can take up to a minute)
            </div>
          )}
          {optimistic && (
            <>
              <Bubble m={{ id: -1, at: new Date().toISOString(), role: 'user', text: optimistic.text, heard: null, files: [], cards: [], error: null }} localFiles={optimistic.files} />
              <div className="flex items-center gap-2 self-start rounded-[10px] bg-white px-3 py-2.5 text-[13px] text-ink-3 shadow-[0_0_0_1px_var(--color-line)]">
                <Spinner /> {optimistic.files.some((f) => f.kind === 'audio') ? 'Listening…' : optimistic.files.length ? 'Reading…' : 'Thinking…'}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-line bg-white px-3 pb-3 pt-2 sm:px-4">
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {files.map((f) => (
              <div key={f.key} className="relative">
                {f.kind === 'image' ? (
                  <img src={f.previewUrl} alt={f.name} className="size-16 rounded-[6px] border border-line object-cover" />
                ) : f.kind === 'pdf' ? (
                  <div className="grid size-16 place-items-center rounded-[6px] border border-line bg-paper text-xs font-bold text-brick">PDF</div>
                ) : (
                  <audio src={f.previewUrl} controls className="h-10 w-[220px]" />
                )}
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.key !== f.key))} className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-ink text-white">
                  <svg aria-hidden width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <IconButton label="Take a photo" onClick={() => cameraRef.current?.click()}>
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
            <circle cx="12" cy="13" r="3.5" />
          </IconButton>
          <IconButton label="Attach photo or PDF" onClick={() => photoRef.current?.click()}>
            <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
          </IconButton>
          <textarea
            aria-label="Message"
            rows={1}
            value={text}
            placeholder="Message or voice note…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="max-h-32 min-h-10 flex-1 resize-none rounded-[6px] border border-line-2 bg-white px-3 py-2 text-[15px] outline-none focus:border-teal"
          />
          {text.trim() || files.length ? (
            <Button variant="primary" onClick={() => submit()} busy={send.isPending} aria-label="Send" className="h-10 w-12 px-0">
              {!send.isPending && (
                <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              )}
            </Button>
          ) : (
            <VoiceButton disabled={send.isPending} onFallback={() => audioFileRef.current?.click()} onDone={(p) => submit({ text: '', files: [p] })} />
          )}
        </div>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (void addFiles(e.target.files), (e.target.value = ''))} />
        <input ref={photoRef} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => (void addFiles(e.target.files), (e.target.value = ''))} />
        <input ref={audioFileRef} type="file" accept="audio/*" capture hidden onChange={(e) => (void addFiles(e.target.files), (e.target.value = ''))} />
      </div>
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid size-10 flex-none place-items-center rounded-[6px] text-ink-2 hover:bg-paper">
      <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

// ------------------------------------------------------------------ voice notes

const MAX_SECONDS = 120;

function VoiceButton({ disabled, onDone, onFallback }: { disabled: boolean; onDone: (p: Pending) => void; onFallback: () => void }) {
  const toast = useToast();
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [secs, setSecs] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setSecs((s) => (s + 1 >= MAX_SECONDS ? (rec.state === 'recording' && rec.stop(), s + 1) : s + 1)), 1000);
    return () => clearInterval(t);
  }, [rec]);

  const start = async () => {
    // Browsers only allow the microphone on https or on this computer itself; on other
    // computers/phones over plain http we fall back to the phone's own voice recorder.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return onFallback();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast({ tone: 'bad', text: 'Microphone not allowed. Allow it in the browser, or attach a recording.' });
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    cancelled.current = false;
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setRec(null);
      setSecs(0);
      if (cancelled.current || !chunks.length) return;
      const blob = new Blob(chunks, { type: (r.mimeType || 'audio/webm').split(';')[0] });
      onDone({ key: uuid(), kind: 'audio', mimeType: blob.type, base64: await toBase64(blob), previewUrl: URL.createObjectURL(blob), name: 'Voice note' });
    };
    r.start();
    setRec(r);
  };

  if (rec) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="flex h-10 items-center gap-2 rounded-[6px] bg-bad-soft px-3 text-sm font-bold text-bad-ink">
          <span className="size-2.5 animate-pulse rounded-full bg-bad" />
          {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
        </span>
        <Button size="md" variant="ghost" onClick={() => ((cancelled.current = true), rec.stop())}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => rec.stop()} className="h-10">
          Send
        </Button>
      </div>
    );
  }
  return (
    <Button variant="dark" disabled={disabled} onClick={() => void start()} aria-label="Record a voice note" title="Record a voice note" className="h-10 w-12 px-0">
      <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </Button>
  );
}

async function toBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ------------------------------------------------------------------ messages

/** Chat files need the login headers, so they are fetched rather than linked. */
function useChatFile(url: string | null) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let gone = false;
    let made: string | null = null;
    const headers: Record<string, string> = {};
    if (store.deviceToken) headers['x-device-token'] = store.deviceToken;
    if (store.sessionToken) headers.authorization = `Bearer ${store.sessionToken}`;
    fetch(url, { headers })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && !gone) setSrc((made = URL.createObjectURL(b)));
      })
      .catch(() => {});
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [url]);
  return src;
}

function StoredFileView({ messageId, n, kind }: { messageId: number; n: number; kind: string }) {
  const src = useChatFile(`/api/assistant/files/${messageId}/${n}`);
  if (!src) return <div className="size-24 animate-pulse rounded-[6px] bg-white/20" />;
  if (kind === 'audio') return <audio src={src} controls className="h-10 w-[240px] max-w-full" />;
  if (kind === 'pdf')
    return (
      <a href={src} target="_blank" rel="noreferrer" className="grid size-24 place-items-center rounded-[6px] bg-white text-sm font-bold text-brick">
        PDF
      </a>
    );
  return (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt="Attached photo" className="max-h-48 max-w-[220px] rounded-[6px] object-cover" />
    </a>
  );
}

function Bubble({ m, localFiles, onRetry, retrying }: { m: AssistantMessage; localFiles?: Pending[]; onRetry?: () => void; retrying?: boolean }) {
  if (m.role === 'user') {
    return (
      <div className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
        {(localFiles?.length || m.files.length > 0) && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {localFiles
              ? localFiles.map((f) =>
                  f.kind === 'audio' ? <audio key={f.key} src={f.previewUrl} controls className="h-10 w-[240px]" /> : f.kind === 'image' ? <img key={f.key} src={f.previewUrl} alt="" className="max-h-48 max-w-[220px] rounded-[6px]" /> : <div key={f.key} className="grid size-24 place-items-center rounded-[6px] bg-white text-sm font-bold text-brick">PDF</div>,
                )
              : m.files.map((f, i) => <StoredFileView key={i} messageId={m.id} n={i + 1} kind={f.kind} />)}
          </div>
        )}
        {m.text && <div className="whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-ink px-3 py-2 text-[15px] text-white">{m.text}</div>}
        {m.heard && (
          <div className="rounded-[10px] rounded-br-[3px] bg-teal-soft px-3 py-2 text-[14px] text-teal">
            <span className="mr-1 text-[11px] font-bold uppercase tracking-[.08em]">Heard</span> {m.heard}
          </div>
        )}
        {m.id > 0 && <span className="text-[11px] text-ink-3">{fmtTime(m.at)}</span>}
      </div>
    );
  }
  return (
    <div className="flex max-w-[92%] flex-col gap-2 self-start">
      {m.error ? (
        <>
          <Notice tone="bad">{m.error}</Notice>
          {onRetry && (
            <div>
              <Button size="sm" onClick={onRetry} busy={retrying}>
                {retrying ? 'Trying again…' : 'Try again'}
              </Button>
            </div>
          )}
        </>
      ) : (
        m.text && <div className="whitespace-pre-wrap rounded-[10px] rounded-bl-[3px] bg-white px-3 py-2 text-[15px] shadow-[0_0_0_1px_var(--color-line)]">{m.text}</div>
      )}
      {m.cards.map((c, i) => (
        <CardView key={i} card={c} messageId={m.id} index={i} />
      ))}
      <span className="text-[11px] text-ink-3">{fmtTime(m.at)}</span>
    </div>
  );
}

// ------------------------------------------------------------------ action cards

function CardView({ card, messageId, index }: { card: AssistantCard; messageId: number; index: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useSession();
  const [busy, setBusy] = useState(false);

  const mark = async (status: 'done' | 'dismissed', result?: { label: string; link?: string }) => {
    await post(`/api/assistant/messages/${messageId}/cards/${index}`, { status, result }).catch(() => {});
    qc.setQueryData<AssistantMessage[]>(['assistant'], (old) =>
      old?.map((m) => (m.id === messageId ? { ...m, cards: m.cards.map((c, i) => (i === index ? ({ ...c, status, result } as AssistantCard) : c)) } : m)),
    );
  };

  const run = async (fn: () => Promise<{ label: string; link?: string }>) => {
    setBusy(true);
    try {
      const r = await fn();
      await mark('done', r);
      toast({ tone: 'good', text: r.label });
    } catch (e) {
      toast({ tone: 'bad', text: e instanceof ApiError ? e.message : 'That did not work. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  const done = card.status !== 'proposed';
  let title = '';
  let body: React.ReactNode = null;
  let action: React.ReactNode = null;

  switch (card.kind) {
    case 'purchase': {
      const s = card.scan;
      title = 'Supplier bill';
      body = (
        <>
          <div className="text-[15px] font-bold">{s.supplier.name ?? 'Supplier not read'}</div>
          <div className="text-[13px] text-ink-3">
            {[s.invoice.number && `Bill ${s.invoice.number}`, s.invoice.date, `${s.lines.length} item${s.lines.length === 1 ? '' : 's'}`, s.grandTotalPaise != null && `₹${formatPaise(s.grandTotalPaise)}`].filter(Boolean).join(' · ')}
          </div>
          <ul className="mt-2 flex flex-col gap-0.5 text-[13px]">
            {s.lines.slice(0, 6).map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate">{l.description}</span>
                <span className="num text-ink-3">{l.qtyMilli != null ? formatQty(l.qtyMilli) : '?'} {l.billUnit ?? ''}</span>
                {l.match.productId ? <Badge tone="good">matched</Badge> : <Badge tone="warn">new</Badge>}
              </li>
            ))}
            {s.lines.length > 6 && <li className="text-ink-3">+ {s.lines.length - 6} more</li>}
          </ul>
          {s.duplicateOf && <div className="mt-2"><Notice tone="bad">Already entered as {s.duplicateOf}.</Notice></div>}
        </>
      );
      action = (
        <Button
          variant="primary"
          onClick={() => {
            void mark('done', { label: 'Opened for review' });
            navigate('/purchases/new', { state: { scan: s } });
          }}
        >
          Review &amp; save purchase
        </Button>
      );
      break;
    }
    case 'bill': {
      title = 'Bill draft';
      body = (
        <>
          <div className="text-[15px] font-bold">
            {card.customer?.name ?? card.walkinName ?? 'Walk-in'} <span className="text-[13px] font-normal text-ink-3">· {MODE_LABEL[card.mode]}</span>
          </div>
          {card.customer && card.customer.balance_paise !== 0 && <div className="text-[13px] text-ink-3">Owes ₹{formatPaise(card.customer.balance_paise)} now</div>}
          <ul className="mt-2 flex flex-col gap-0.5 text-[13px]">
            {card.lines.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate">{l.name}</span>
                <span className="num font-bold">
                  {formatQty(l.qtyMilli)} {l.unitCode}
                </span>
                {l.unitCode && l.stockMilli < l.qtyMilli && <Badge tone="bad">stock {formatQty(l.stockMilli)}</Badge>}
              </li>
            ))}
          </ul>
          {card.warnings.map((w, i) => (
            <div key={i} className="mt-2"><Notice tone="warn">{w}</Notice></div>
          ))}
        </>
      );
      action = can('billing.create') && (
        <Button
          variant="primary"
          onClick={() => {
            void mark('done', { label: 'Opened in billing' });
            navigate('/billing', { state: { assistantBill: card } });
          }}
        >
          Open in Billing
        </Button>
      );
      break;
    }
    case 'stock_adjust': {
      title = 'Stock correction';
      const after = card.currentMilli + card.deltaMilli;
      body = (
        <>
          <div className="text-[15px] font-bold">{card.name}</div>
          <div className="num mt-1 text-[14px]">
            {formatQty(card.currentMilli)} → <b className={after < 0 ? 'text-bad' : ''}>{formatQty(after)}</b> {card.unitCode}{' '}
            <span className={card.deltaMilli < 0 ? 'text-bad' : 'text-good'}>
              ({card.deltaMilli > 0 ? '+' : ''}
              {formatQty(card.deltaMilli)})
            </span>
          </div>
          <div className="text-[13px] text-ink-3">Reason: {card.reason}</div>
        </>
      );
      action = (
        <Button
          variant="primary"
          busy={busy}
          onClick={() =>
            run(async () => {
              const r = await post<{ qtyMilli: number }>(`/api/products/${card.productId}/adjust`, { deltaMilli: card.deltaMilli, reason: `${card.reason} (assistant)` });
              qc.invalidateQueries({ queryKey: ['products'] });
              return { label: `Stock of ${card.name} is now ${formatQty(r.qtyMilli)} ${card.unitCode}` };
            })
          }
        >
          Change stock
        </Button>
      );
      break;
    }
    case 'customer': {
      title = 'New customer';
      body = (
        <>
          <div className="text-[15px] font-bold">{card.name}</div>
          <div className="text-[13px] text-ink-3">{[card.phone, card.gstin, card.address].filter(Boolean).join(' · ') || 'No phone or address'}</div>
          {card.warnings.map((w, i) => (
            <div key={i} className="mt-2"><Notice tone="warn">{w}</Notice></div>
          ))}
        </>
      );
      action = (
        <Button
          variant="primary"
          busy={busy}
          onClick={() =>
            run(async () => {
              await post('/api/customers', { name: card.name, phone: card.phone ?? undefined, gstin: card.gstin ?? undefined, address: card.address ?? undefined });
              qc.invalidateQueries({ queryKey: ['customers'] });
              return { label: `${card.name} added to customers` };
            })
          }
        >
          Save customer
        </Button>
      );
      break;
    }
    case 'payment': {
      title = 'Payment received';
      body = (
        <>
          <div className="text-[15px] font-bold">{card.name}</div>
          <div className="num mt-1 text-[20px] font-extrabold">₹{formatPaise(card.amountPaise)}</div>
          <div className="text-[13px] text-ink-3">
            {MODE_LABEL[card.mode]} · owes ₹{formatPaise(card.balancePaise)} now → ₹{formatPaise(card.balancePaise - card.amountPaise)} after
          </div>
        </>
      );
      action = (
        <Button
          variant="primary"
          busy={busy}
          onClick={() =>
            run(async () => {
              const r = await post<{ number: string }>('/api/receipts', { clientRef: uuid(), customerId: card.customerId, mode: card.mode, amountPaise: card.amountPaise, notes: 'Entered through the assistant' });
              qc.invalidateQueries({ queryKey: ['customers'] });
              return { label: `Receipt ${r.number} saved` };
            })
          }
        >
          Save receipt
        </Button>
      );
      break;
    }
  }

  return (
    <div className={cx('w-full max-w-[460px] rounded-[8px] border bg-white p-3', done ? 'border-line opacity-80' : 'border-brick shadow-[inset_3px_0_0_#c2491a]')}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[.12em] text-ink-3">{title}</span>
        {card.status === 'done' && <Badge tone="good">Done</Badge>}
        {card.status === 'dismissed' && <Badge>Dismissed</Badge>}
      </div>
      {body}
      {card.status === 'done' && card.result && <div className="mt-2 text-[13px] font-semibold text-good">{card.result.label}</div>}
      {!done && (
        <div className="mt-3 flex flex-wrap gap-2">
          {action}
          <Button variant="ghost" onClick={() => void mark('dismissed')}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
