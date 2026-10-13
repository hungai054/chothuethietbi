import { headers } from 'next/headers';
import { cache } from 'react';
import { resolveTenant, withTenantId } from '@rentpro/db';
import { resolveFeatures, resolveLimits, subdomainOf, type ResolvedFeatures, type Limits } from '@rentpro/tenancy';
import { pool } from './db';

export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  status: string;
  timezone: string;
  features: ResolvedFeatures;
  limits: Limits;
}

const BASE_DOMAIN = process.env.BASE_DOMAIN ?? 'localhost';

/** DEDICATED dùng slug cố định; shared dùng subdomain hoặc tên miền riêng. */
export function slugFromHost(host: string): { slug: string; domain?: string } | null {
  if (process.env.DEPLOY_MODE === 'dedicated') {
    const slug = process.env.DEDICATED_TENANT_SLUG;
    return slug ? { slug } : null;
  }
  const hostname = host.toLowerCase().split(':')[0] ?? '';
  const sub = subdomainOf(host, BASE_DOMAIN);
  return sub ? { slug: sub } : { slug: '', domain: hostname };
}

export async function tenantFromHost(host: string): Promise<TenantInfo | null> {
  const key = slugFromHost(host);
  if (!key) return null;
  const ref = await resolveTenant(pool(), key.slug, key.domain);
  if (!ref) return null;
  return withTenantId(pool(), ref.id, async (db) => {
    const { rows } = await db.query(
      `SELECT t.id, t.slug, t.name, t.status, t.timezone, t.feature_overrides, t.limit_overrides, p.features, p.limits
       FROM tenant t JOIN plan p ON p.id = t.plan_id`,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, slug: r.slug, name: r.name, status: r.status, timezone: r.timezone,
      features: resolveFeatures({ planFeatures: r.features, overrides: r.feature_overrides }),
      limits: resolveLimits(r.limits, r.limit_overrides),
    };
  });
}

/** Tenant của request hiện tại (cache trong một request). */
export const getTenant = cache(async (): Promise<TenantInfo | null> => {
  const h = await headers();
  return tenantFromHost(h.get('host') ?? '');
});
