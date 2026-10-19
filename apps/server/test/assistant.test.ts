import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/services/common.js';
import { GEMINI_RETRY_WAITS_MS, postGemini } from '../src/services/scanner.js';
import type { AgentReply, GeminiContent } from '../src/services/assistant.js';
import { rankProducts } from '../src/services/assistant.js';
import type { ReadBill } from '../src/services/scanner.js';
import { makeHarness } from './harness.js';

/** The fake model answers from a script: each call takes the next reply and records what it was sent. */
let script: ((contents: GeminiContent[]) => AgentReply)[] = [];
const seen: GeminiContent[][] = [];
let fakeRead: ReadBill;

let h: Awaited<ReturnType<typeof makeHarness>>;
let admin: Awaited<ReturnType<typeof h.loginAs>>;
let counter: Awaited<ReturnType<typeof h.loginAs>>;
let stock: Awaited<ReturnType<typeof h.loginAs>>;
let cementId: number;
let customerId: number;

beforeAll(async () => {
  h = await makeHarness({
    scanner: async () => fakeRead,
    assistant: async ({ contents }) => {
      seen.push(structuredClone(contents));
      const next = script.shift();
      if (!next) throw new Error('assistant called more times than scripted');
      return next(contents);
    },
  });
  admin = await h.loginAs('admin');
  counter = await h.loginAs('counter');
  stock = await h.loginAs('stock');
  await admin.put('/api/settings', { geminiApiKey: 'test-key' });
  cementId = await h.product({ qty: 40, price: 35000 });
  await h.app`update products set name = ${'Zeta PPC Cement 50kg ' + h.tag} where id = ${cementId}`;
  const c = await admin.post('/api/customers', { name: `Reddy Builders ${h.tag}`, phone: '9876500000' });
  customerId = c.body.id;
});
afterAll(() => h.close());

const lastText = (c: GeminiContent[]) => c[c.length - 1]!.parts.map((p) => ('text' in p ? p.text : '')).join('\n');
const tinyJpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
const tinyAudio = Buffer.from('1a45dfa3010000000000001f4286810142f7810142f2810442f381084282847765626d', 'hex').toString('base64');

describe('assistant', () => {
  it('looks things up, then proposes a bill as a card — nothing is saved', async () => {
    const [before] = await h.app<{ n: number }[]>`select count(*)::int as n from sales_invoices`;
    script = [
      () => ({ reply: '', lookups: [{ tool: 'find_products', query: `zeta ppc ${h.tag}` }, { tool: 'find_customers', query: `Reddy Builders ${h.tag}` }], actions: [] }),
      (contents) => {
        const results = lastText(contents);
        expect(results).toContain(`"product_id":${cementId}`);
        expect(results).toContain(`"customer_id":${customerId}`);
        expect(results).toContain('"in_stock":40');
        return {
          reply: 'Bill ready for 20 bags on credit — check and confirm the card.',
          lookups: [],
          actions: [{ type: 'bill_draft', customer_id: customerId, payment_mode: 'credit', items: [{ product_id: cementId, qty: 20, unit: 'bags' }, { product: 'unicorn paint', qty: 1 }] }],
        };
      },
    ];
    const r = await counter.post('/api/assistant/messages', { text: `20 bags zeta cement to Reddy on credit` });
    expect(r.status).toBe(200);
    const [mine, reply] = r.body.messages;
    expect(mine.role).toBe('user');
    expect(reply.text).toContain('check and confirm');
    expect(reply.cards).toHaveLength(1);
    const card = reply.cards[0];
    expect(card).toMatchObject({ kind: 'bill', status: 'proposed', mode: 'credit', customer: { id: customerId } });
    expect(card.lines).toEqual([expect.objectContaining({ productId: cementId, qtyMilli: 20000, unitCode: 'bag', stockMilli: 40000 })]);
    expect(card.warnings.join(' ')).toContain('unicorn paint');
    const [after] = await h.app<{ n: number }[]>`select count(*)::int as n from sales_invoices`;
    expect(after!.n).toBe(before!.n);
    expect(await h.stockOf(cementId)).toBe(40000);

    // the person confirmed it on the billing screen → the card is marked done
    const u = await counter.post(`/api/assistant/messages/${reply.id}/cards/0`, { status: 'done', result: { label: 'KPH/26-27/000999' } });
    expect(u.status).toBe(200);
    const list = await counter.get('/api/assistant/messages');
    expect(list.body.at(-1).cards[0]).toMatchObject({ status: 'done', result: { label: 'KPH/26-27/000999' } });
    // other people can't see or change someone else's chat
    expect((await admin.get('/api/assistant/messages')).body.find((m: { id: number }) => m.id === reply.id)).toBeUndefined();
    expect((await admin.post(`/api/assistant/messages/${reply.id}/cards/0`, { status: 'dismissed' })).status).toBe(404);
  });

  it('sends earlier messages as context', async () => {
    script = [() => ({ reply: 'Yes.', lookups: [], actions: [] })];
    await counter.post('/api/assistant/messages', { text: 'and one more thing' });
    const ctx = seen.at(-1)!;
    expect(ctx[0]!.role).toBe('user');
    expect(JSON.stringify(ctx)).toContain('20 bags zeta cement');
    expect(JSON.stringify(ctx)).toContain('[cards: bill done (KPH/26-27/000999)]');
  });

  it('voice notes: keeps the audio, shows what was heard', async () => {
    script = [() => ({ heard: '5 సిమెంట్ బస్తాలు పాడయ్యాయి', reply: 'Stock card ready.', lookups: [], actions: [{ type: 'stock_adjust', product_id: cementId, qty_change: -5, reason: 'Damaged bags' }] })];
    const r = await stock.post('/api/assistant/messages', { files: [{ mimeType: 'audio/webm;codecs=opus', base64: tinyAudio }] });
    expect(r.status).toBe(200);
    const [mine, reply] = r.body.messages;
    expect(mine.heard).toBe('5 సిమెంట్ బస్తాలు పాడయ్యాయి');
    expect(mine.files).toEqual([expect.objectContaining({ kind: 'audio', mimeType: 'audio/webm' })]);
    const sent = seen.at(-1)!.at(-1)!.parts.find((p) => 'inline_data' in p) as { inline_data: { mime_type: string } };
    expect(sent.inline_data.mime_type).toBe('audio/webm');
    expect(reply.cards[0]).toMatchObject({ kind: 'stock_adjust', productId: cementId, deltaMilli: -5000, currentMilli: 40000, reason: 'Damaged bags' });
    expect(await h.stockOf(cementId)).toBe(40000);
    const f = await h.server.inject({ method: 'GET', url: `/api/assistant/files/${mine.id}/1`, headers: { 'x-device-token': h.deviceToken, authorization: `Bearer ${stock.token}` } });
    expect(f.statusCode).toBe(200);
    expect(f.headers['content-type']).toBe('audio/webm');
  });

  it('respects permissions: counter staff get no stock card', async () => {
    script = [() => ({ reply: 'Okay.', lookups: [], actions: [{ type: 'stock_adjust', product_id: cementId, new_qty: 30, reason: 'count' }] })];
    const r = await counter.post('/api/assistant/messages', { text: 'set cement stock to 30' });
    expect(r.body.messages[1].cards).toEqual([]);
    expect(r.body.messages[1].text).toContain('ask admin');
  });

  it('counter staff cannot see sales reports through the assistant', async () => {
    script = [
      () => ({ reply: '', lookups: [{ tool: 'sales_summary' }], actions: [] }),
      (c) => {
        expect(lastText(c)).toContain('not allowed to see sales reports');
        return { reply: 'Sorry, ask admin.', lookups: [], actions: [] };
      },
    ];
    await counter.post('/api/assistant/messages', { text: "today's sales?" });
    expect(script).toHaveLength(0);
  });

  it('a supplier bill photo becomes a purchase card via the scanner', async () => {
    fakeRead = {
      supplier: { name: 'Some Dealer', gstin: null, phone: null, address: null },
      invoice: { number: `AI-${h.tag}`, date: '2026-10-10', is_interstate: false },
      lines: [{ description: `Zeta PPC Cement 50kg ${h.tag}`, item_code: null, hsn: '2523', quantity: 100, unit: 'bags', rate: 300, discount_percent: null, taxable_value: 30000, gst_percent: 18, line_total: 35400 }],
      freight: null,
      round_off: null,
      grand_total: 35400,
      notes: null,
    };
    script = [() => ({ reply: 'This is a supplier bill — review and save it.', lookups: [], actions: [{ type: 'purchase_from_photo' }] })];
    const r = await stock.post('/api/assistant/messages', { text: '', files: [{ mimeType: 'image/jpeg', base64: tinyJpeg }] });
    expect(r.status).toBe(200);
    const card = r.body.messages[1].cards[0];
    expect(card.kind).toBe('purchase');
    expect(card.scan.invoice.number).toBe(`AI-${h.tag}`);
    expect(card.scan.lines[0].match.productId).toBe(cementId);
    const [p] = await h.app<{ n: number }[]>`select count(*)::int as n from purchase_invoices where supplier_invoice_no = ${`AI-${h.tag}`}`;
    expect(p!.n).toBe(0);
    expect(await h.stockOf(cementId)).toBe(40000);
  });

  it('try again: a failed answer is hidden and the same message (with its voice note) is answered again', async () => {
    script = [
      () => {
        throw new AppError(503, 'GEMINI_BUSY', 'Google Gemini is overloaded right now');
      },
    ];
    const r = await admin.post('/api/assistant/messages', { text: 'stock?', files: [{ mimeType: 'audio/webm', base64: tinyAudio }] });
    const failed = r.body.messages[1];
    expect(failed.error).toContain('overloaded');
    script = [
      (c) => {
        const last = c[c.length - 1]!;
        expect(last.parts.some((p) => 'inline_data' in p)).toBe(true);
        return { heard: 'stock?', reply: 'Here you go.', lookups: [], actions: [] };
      },
    ];
    const again = await admin.post(`/api/assistant/messages/${failed.id}/retry`);
    expect(again.status).toBe(200);
    expect(again.body.messages[0].id).toBe(r.body.messages[0].id);
    expect(again.body.messages[1].text).toBe('Here you go.');
    const list = (await admin.get('/api/assistant/messages')).body as { id: number }[];
    expect(list.find((m) => m.id === failed.id)).toBeUndefined();
    // only a failed answer can be retried
    expect((await admin.post(`/api/assistant/messages/${again.body.messages[1].id}/retry`)).status).toBe(404);
  });

  it('rejects files that are not photos, PDFs or audio', async () => {
    const r = await admin.post('/api/assistant/messages', { files: [{ mimeType: 'application/x-msdownload', base64: tinyJpeg }] });
    expect(r.status).toBe(400);
  });

  it('without a Gemini key the message is kept and the problem is shown', async () => {
    await admin.put('/api/settings', { geminiApiKey: '' });
    const r = await admin.post('/api/assistant/messages', { text: 'hello' });
    await admin.put('/api/settings', { geminiApiKey: 'test-key' });
    expect(r.status).toBe(200);
    expect(r.body.messages[1].error).toContain('Gemini API key');
  });

  it('clear chat hides messages without deleting them', async () => {
    await counter.post('/api/assistant/clear');
    expect((await counter.get('/api/assistant/messages')).body).toEqual([]);
    const [n] = await h.app<{ n: number }[]>`select count(*)::int as n from assistant_messages where user_id = ${h.users.counter.id}`;
    expect(n!.n).toBeGreaterThan(0);
  });
});

describe('rankProducts', () => {
  const ps = [
    { name: 'UltraTech PPC Cement 50kg', sku: 'UT-PPC' },
    { name: 'UltraTech OPC 53 Cement 50kg', sku: 'UT-OPC' },
    { name: 'JSW Neosteel TMT 12mm rod', sku: 'JSW-12' },
    { name: 'JSW Neosteel TMT 8mm rod', sku: 'JSW-8' },
  ];
  it('ranks by words, sizes matter', () => {
    expect(rankProducts(ps, 'ppc cement')[0]!.sku).toBe('UT-PPC');
    expect(rankProducts(ps, '12 mm rod')[0]!.sku).toBe('JSW-12');
    expect(rankProducts(ps, 'tmt 8mm')[0]!.sku).toBe('JSW-8');
    expect(rankProducts(ps, 'asian paints')).toEqual([]);
  });
});

describe('postGemini', () => {
  it('tries again when Google is overloaded, then gives a plain message', async () => {
    const waits = [...GEMINI_RETRY_WAITS_MS];
    GEMINI_RETRY_WAITS_MS.splice(0, waits.length, 0, 0);
    const busy = () => new Response(JSON.stringify({ error: { message: 'This model is currently experiencing high demand.' } }), { status: 503 });
    const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }), { status: 200 });
    try {
      const f1 = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
      vi.stubGlobal('fetch', f1);
      expect(await postGemini('k', 'm', {})).toBe('hi');
      expect(f1).toHaveBeenCalledTimes(2);

      const f2 = vi.fn().mockImplementation(async () => busy());
      vi.stubGlobal('fetch', f2);
      await expect(postGemini('k', 'm', {})).rejects.toThrow(/overloaded right now/);
      expect(f2).toHaveBeenCalledTimes(3);

      const f3 = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }));
      vi.stubGlobal('fetch', f3);
      await expect(postGemini('k', 'm', {})).rejects.toThrow(/key is not valid/);
      expect(f3).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      GEMINI_RETRY_WAITS_MS.splice(0, 2, ...waits);
    }
  });
});

describe('rankProducts with several words', () => {
  it('needs most words to match', () => {
    const ps = [{ name: 'Birla Opus Interior Paint 20L', sku: 'BO-20' }, { name: 'UltraTech PPC Cement 50kg', sku: 'UT' }];
    expect(rankProducts(ps, 'unicorn paint')).toEqual([]);
    expect(rankProducts(ps, 'opus paint')[0]!.sku).toBe('BO-20');
  });
});
