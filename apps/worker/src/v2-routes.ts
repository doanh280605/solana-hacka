import type { FastifyInstance } from 'fastify';
import { WalletAuth } from './auth.js';
import { HttpError } from './errors.js';
import { MAX_UPLOAD_BYTES } from './types.js';
import type { ProductService } from './v2-service.js';

function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new HttpError(400, 'Invalid request fields');
  return value as Record<string, unknown>;
}
export function registerV2Routes(app: FastifyInstance, auth: WalletAuth, product: ProductService): void {
  app.get('/api/v2/service', async () => ({ service: 'product-listing-pack', aiMode: product.ai.mode,
    liveConfigured: product.ai.mode === 'live' && product.ai.available(), rehearsalStallEnabled: !!product.settings.allowRehearsalStall }));
  app.post('/api/auth/nonce', { bodyLimit: 4096 }, async request => {
    const data = body(request.body, ['wallet']); return auth.nonce(data.wallet, request);
  });
  app.post('/api/auth/verify', { bodyLimit: 4096 }, async (request, reply) => {
    const data = body(request.body, ['wallet', 'nonce', 'signature']);
    const verified = await auth.verify(data.wallet, data.nonce, data.signature, request);
    reply.header('Set-Cookie', verified.cookie); return verified.session;
  });
  app.get('/api/auth/session', async request => auth.require(request));
  app.post('/api/auth/logout', { bodyLimit: 256 }, async (request, reply) => {
    reply.header('Set-Cookie', await auth.logout(request)); return { ok: true };
  });
  app.post('/api/v2/orders', async (request, reply) => {
    const session = auth.require(request, true);
    if (!request.isMultipart()) throw new HttpError(400, 'Upload a product image and brief as multipart form data');
    const fields: Record<string, string> = {};
    let file: Buffer | undefined;
    for await (const part of request.parts({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 3, parts: 4, fieldSize: 8000 } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file' || file) throw new HttpError(400, 'Upload exactly one image named file');
        file = await part.toBuffer();
        if (part.file.truncated) throw new HttpError(413, 'Upload one image of at most 5 MiB');
      } else {
        if (!['buyer', 'mode', 'brief'].includes(part.fieldname) || fields[part.fieldname] !== undefined || typeof part.value !== 'string'
          || part.valueTruncated || part.fieldnameTruncated) throw new HttpError(400, 'Supply one buyer, brief, and mode field');
        fields[part.fieldname] = part.value;
      }
    }
    if (!file) throw new HttpError(400, 'Upload one product image');
    const order = await product.create(session.wallet, fields.buyer, fields.mode ?? 'normal', fields.brief, file);
    return reply.code(201).send(order);
  });
  app.get('/api/v2/orders', async request => ({ orders: await product.list(auth.require(request).wallet) }));
  app.get<{ Params: { jobId: string } }>('/api/v2/orders/:jobId', async request => product.read(request.params.jobId, auth.require(request).wallet));
  app.post<{ Params: { jobId: string } }>('/api/v2/orders/:jobId/funded', { bodyLimit: 512 }, async request => {
    const session = auth.require(request, true);
    const data = body(request.body, ['signature']);
    if (data.signature !== undefined && (typeof data.signature !== 'string' || data.signature.length > 128)) throw new HttpError(400, 'Invalid transaction signature hint');
    return product.read(request.params.jobId, session.wallet, true);
  });
  app.get<{ Params: { jobId: string; name: string } }>('/api/v2/orders/:jobId/preview/:name', async (request, reply) => {
    const bytes = await product.preview(request.params.jobId, request.params.name, auth.require(request).wallet);
    return reply.type('image/webp').send(bytes);
  });
  app.post<{ Params: { jobId: string } }>('/api/v2/orders/:jobId/challenge', { bodyLimit: 512 }, async request => {
    const data = body(request.body, ['buyer']); return product.challenge(request.params.jobId, data.buyer);
  });
  app.post<{ Params: { jobId: string } }>('/api/v2/orders/:jobId/download', { bodyLimit: 1024 }, async (request, reply) => {
    const data = body(request.body, ['buyer', 'nonce', 'signature']);
    const bytes = await product.download(request.params.jobId, data.buyer, data.nonce, data.signature);
    reply.header('Content-Disposition', `attachment; filename="osid-${request.params.jobId}.zip"`);
    return reply.type('application/zip').send(bytes);
  });
}
