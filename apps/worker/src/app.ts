import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';
import { WorkerService } from './service.js';
import { MAX_UPLOAD_BYTES, type ChainGateway, type WorkerSettings } from './types.js';
import { WalletAuth } from './auth.js';
import { ProductService } from './v2-service.js';
import { registerV2Routes } from './v2-routes.js';
import type { AiProvider } from './ai.js';

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request body must be a JSON object');
  return value as Record<string, unknown>;
}

export interface WorkerApp {
  app: FastifyInstance;
  service: WorkerService;
  productService: ProductService;
}

export async function createWorker(options: {
  chain: ChainGateway;
  settings: WorkerSettings;
  logger?: boolean;
  ai?: AiProvider;
}): Promise<WorkerApp> {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: MAX_UPLOAD_BYTES + 65536 });
  const service = new WorkerService(options.chain, options.settings, (error, message) => app.log.error({ err: error }, message));
  const productService = new ProductService(options.chain, options.settings, (error, message) => app.log.error({ err: error }, message), options.ai);
  const auth = new WalletAuth(options.chain, options.settings);
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 2, parts: 3, fieldSize: 128 },
    throwFileSizeLimit: true,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if (origin && options.settings.corsOrigins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      if (request.url.split('?')[0] === '/api/config' || request.url.startsWith('/api/v2/') || request.url.startsWith('/api/auth/')) {
        reply.header('Access-Control-Allow-Credentials', 'true');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Osid-CSRF');
      }
      reply.header('Access-Control-Max-Age', '600');
    }
  });
  app.options('/*', async (_request, reply) => reply.code(204).send());

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    const candidate = error as { statusCode?: number; code?: string };
    if (candidate.statusCode && candidate.statusCode >= 400 && candidate.statusCode < 500) {
      return reply.code(candidate.statusCode).send({ error: candidate.statusCode === 413 ? 'Upload one PNG of at most 5 MB' : 'Invalid request' });
    }
    request.log.error({ err: error }, 'Worker request failed');
    return reply.code(500).send({ error: 'Worker request failed' });
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/config', async () => options.chain.config);
  registerV2Routes(app, auth, productService);

  app.post('/api/orders', async (request, reply) => {
    if (!request.isMultipart()) throw new HttpError(415, 'Upload buyer, mode, and one PNG as multipart form data');
    const fields: Record<string, string> = {};
    let file: Buffer | undefined;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file' || file !== undefined) throw new HttpError(400, 'Upload exactly one file named file');
        file = await part.toBuffer();
        if (part.file.truncated) throw new HttpError(413, 'Upload one PNG of at most 5 MB');
      } else {
        if (!['buyer', 'mode'].includes(part.fieldname) || fields[part.fieldname] !== undefined || typeof part.value !== 'string'
          || part.valueTruncated || part.fieldnameTruncated) throw new HttpError(400, 'Only one buyer and one mode field are accepted');
        fields[part.fieldname] = part.value;
      }
    }
    if (!file) throw new HttpError(400, 'Upload one PNG named file');
    const order = await service.create(fields.buyer, fields.mode, file);
    return reply.code(201).send(order);
  });

  app.get<{ Querystring: { buyer?: string } }>('/api/orders', async request => ({ orders: await service.list(request.query.buyer) }));
  app.get<{ Params: { jobId: string } }>('/api/orders/:jobId', async request => service.read(request.params.jobId));
  app.post<{ Params: { jobId: string } }>('/api/orders/:jobId/funded', async request => {
    const body = objectBody(request.body);
    if (Object.keys(body).some(key => key !== 'signature')
      || (body.signature !== undefined && (typeof body.signature !== 'string' || body.signature.length > 128))) {
      throw new HttpError(400, 'Expected an optional transaction signature');
    }
    // Signature is a UX hint only. It never authorizes conversion.
    return service.read(request.params.jobId, true);
  });
  app.get<{ Params: { jobId: string } }>('/api/orders/:jobId/preview', async (request, reply) => {
    const bytes = await service.preview(request.params.jobId);
    return reply.type('image/webp').send(bytes);
  });
  app.post<{ Params: { jobId: string } }>('/api/orders/:jobId/challenge', async request => {
    const body = objectBody(request.body);
    if (Object.keys(body).some(key => key !== 'buyer')) throw new HttpError(400, 'Expected the buyer public key');
    return service.challenge(request.params.jobId, body.buyer);
  });
  app.post<{ Params: { jobId: string } }>('/api/orders/:jobId/download', async (request, reply) => {
    const body = objectBody(request.body);
    if (Object.keys(body).some(key => !['buyer', 'nonce', 'signature'].includes(key))) throw new HttpError(400, 'Expected buyer, nonce, and signature');
    const bytes = await service.download(request.params.jobId, body.buyer, body.nonce, body.signature);
    reply.header('Content-Disposition', `attachment; filename="holdfast-${request.params.jobId}.webp"`);
    return reply.type('image/webp').send(bytes);
  });
  app.addHook('onClose', async () => { await Promise.all([service.close(), productService.close()]); });
  await auth.initialize();
  await service.initialize();
  await productService.initialize();
  return { app, service, productService };
}
