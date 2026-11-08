import { workerUrl } from './config';
import type { Purchase } from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

let csrfToken: string | null = null;
export function setCsrfToken(value: string | null) { csrfToken = value; }

export async function apiResponse(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.method && !['GET', 'HEAD'].includes(options.method) && csrfToken) headers.set('X-Osid-CSRF', csrfToken);
  const response = await fetch(`${workerUrl}${path}`, { ...options, headers, credentials: 'include', cache: 'no-store' });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string; message?: string; code?: string } | null;
    throw new ApiError(data?.error || data?.message || `Service returned HTTP ${response.status}.`, response.status, data?.code);
  }
  return response;
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  return (await apiResponse(path, options)).json() as Promise<T>;
}

export function post<T>(path: string, data: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

const storageKey = 'osid.orders.v2';
const legacyKey = 'holdfast.orders.v1';

function isPurchase(value: unknown): value is Purchase {
  if (!value || typeof value !== 'object') return false;
  const record = value as Purchase;
  return typeof record.buyer === 'string' && /^[a-f0-9]{64}$/.test(record.jobId) && typeof record.jobAddress === 'string' && typeof record.amount === 'string' && Number.isSafeInteger(record.expiresAt);
}

export function savedOrders(buyer: string): Purchase[] {
  try {
    const current: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    const legacy: unknown = JSON.parse(localStorage.getItem(legacyKey) || '[]');
    const records = [...(Array.isArray(current) ? current : []), ...(Array.isArray(legacy) ? legacy : [])];
    return records.filter(isPurchase).filter((order, index, all) => order.buyer === buyer && all.findIndex((item) => item.jobAddress === order.jobAddress) === index);
  } catch { return []; }
}

export function persistOrder(order: Purchase): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    const records = Array.isArray(raw) ? raw.filter(isPurchase) : [];
    // Only public recovery metadata is saved. Photos, briefs, copy and credentials stay out of localStorage.
    const { version, jobId, jobAddress, buyer, merchant, mint, amount, expiresAt, mode, status } = order;
    const record: Purchase = { version, jobId, jobAddress, buyer, merchant, mint, amount, expiresAt, mode, status };
    localStorage.setItem(storageKey, JSON.stringify([record, ...records.filter((item) => item.jobAddress !== order.jobAddress)].slice(0, 40)));
  } catch { /* The recovery address also remains visible in the payment receipt. */ }
}

export function previewPath(jobId: string, name: string, source: string): string {
  const expected = `/api/v2/orders/${jobId}/preview/${encodeURIComponent(name)}`;
  const url = new URL(source, `${workerUrl}/`);
  if (url.origin !== new URL(workerUrl).origin || url.pathname !== expected || url.search || url.hash) throw new Error('Unexpected private preview location.');
  return expected;
}
