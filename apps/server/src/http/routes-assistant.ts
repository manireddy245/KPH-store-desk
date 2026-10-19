import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../services/common.js';
import { clearChat, listMessages, readChatFile, sendMessage, updateCard, type AssistantModel, type StoredFile } from '../services/assistant.js';
import type { ModelCaller } from '../services/scanner.js';
import { ctxOf, type Shared } from './app.js';

const id = z.coerce.number().int().positive();

export async function registerAssistantRoutes(app: FastifyInstance, { db }: Shared, opts: { assistant?: AssistantModel; scanner?: ModelCaller } = {}) {
  app.get('/api/assistant/messages', async (req) => {
    const q = z.object({ before: id.optional() }).parse(req.query);
    return listMessages(db.app, ctxOf(req), q);
  });

  /** Text, photos/PDFs and voice notes. The answer may carry cards to confirm; nothing is saved by the assistant. */
  app.post('/api/assistant/messages', async (req) => {
    const b = z
      .object({
        text: z.string().max(4000).optional(),
        files: z.array(z.object({ mimeType: z.string().max(100), base64: z.string().min(10) })).max(6).optional(),
      })
      .parse(req.body);
    return sendMessage(db.app, ctxOf(req), b, { scanDir: db.scanDir, model: opts.assistant, scanner: opts.scanner });
  });

  app.post('/api/assistant/messages/:id/cards/:n', async (req) => {
    const p = z.object({ id, n: z.coerce.number().int().min(0) }).parse(req.params);
    const b = z.object({ status: z.enum(['done', 'dismissed']), result: z.object({ label: z.string().max(200), link: z.string().max(200).optional() }).optional() }).parse(req.body);
    return updateCard(db.app, ctxOf(req), p.id, p.n, b);
  });

  app.post('/api/assistant/clear', async (req) => clearChat(db.app, ctxOf(req)));

  app.get('/api/assistant/files/:id/:n', async (req, reply) => {
    const ctx = ctxOf(req);
    const p = z.object({ id, n: z.coerce.number().int().min(1) }).parse(req.params);
    const [m] = await db.app<{ files: StoredFile[] }[]>`select files from assistant_messages where id = ${p.id} and user_id = ${ctx.userId}`;
    const f = m?.files?.[p.n - 1];
    if (!f) throw new AppError(404, 'NOT_FOUND', 'File not found');
    return reply.header('content-type', f.mimeType).header('cache-control', 'private, max-age=86400').send(readChatFile(db.scanDir, f.file));
  });
}
