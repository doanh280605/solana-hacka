import { workerUrl } from './config';
import type { Order } from './types';

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${workerUrl}${path}`, { ...options, cache: 'no-store' });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw new Error(data?.message || data?.error || `Merchant API returned HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

export function post<T>(path: string, data: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

const storageKey = 'holdfast.orders.v1';

export function savedOrders(buyer: string): Order[] {
  try {
    const records: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(records)) return [];
    return records.filter((order): order is Order => !!order && order.buyer === buyer && /^[a-f0-9]{64}$/.test(order.jobId) && typeof order.jobAddress === 'string');
  } catch { return []; }
}

export function persistOrder(order: Order): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    const records: Order[] = Array.isArray(raw) ? raw : [];
    localStorage.setItem(storageKey, JSON.stringify([order, ...records.filter((item) => item.jobId !== order.jobId)].slice(0, 24)));
  } catch { /* The recovery address remains visible if browser storage is disabled. */ }
}

export function previewSource(order: Order): string {
  return new URL(order.previewUrl || `/api/orders/${order.jobId}/preview`, `${workerUrl}/`).toString();
}
