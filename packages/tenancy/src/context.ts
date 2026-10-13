import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
  userId?: string;
  requestId?: string;
}

const als = new AsyncLocalStorage<TenantContext>();

export const runWithTenant = <T>(ctx: TenantContext, fn: () => T): T => als.run(ctx, fn);

export function currentTenant(): TenantContext {
  const c = als.getStore();
  if (!c) throw new Error('Thiếu ngữ cảnh tenant');
  return c;
}

/** Tách subdomain theo BASE_DOMAIN; null nếu là tên miền khác (tra bảng tenant_domain). */
export function subdomainOf(host: string, baseDomain: string): string | null {
  const h = host.toLowerCase().split(':')[0] ?? '';
  const suffix = '.' + baseDomain.toLowerCase();
  if (!h.endsWith(suffix)) return null;
  const sub = h.slice(0, -suffix.length);
  return /^[a-z0-9-]+$/.test(sub) ? sub : null;
}
