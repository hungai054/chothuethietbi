import { headers } from 'next/headers';
import { cache } from 'react';
import { resolveTenant, withTenantId } from '@rentpro/db';
import { DEFAULT_LIFECYCLE, resolveBranding, resolveLabels, subscriptionPhase, type Labels, type Phase, type ResolvedBranding } from '@rentpro/core';
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
  labels: Labels;
  branding: ResolvedBranding;
  /** Hạn dùng thử/thuê bao đang áp dụng (null = không thời hạn) và giai đoạn hiện tại */
  billing: { endsAt: Date | null; phase: Phase; daysLeft: number | null };
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
      `SELECT t.id, t.slug, t.name, t.status, t.timezone, t.settings, t.feature_overrides, t.limit_overrides, p.features, p.limits, t.trial_ends_at,
              s.period_end, (s.tenant_id IS NOT NULL) AS has_sub, (SELECT value FROM platform_setting WHERE key='billing') AS billing_cfg
       FROM tenant t JOIN plan p ON p.id = t.plan_id LEFT JOIN subscription s ON s.tenant_id = t.id`,
    );
    const r = rows[0];
    if (!r) return null;
    const features = resolveFeatures({ planFeatures: r.features, overrides: r.feature_overrides });
    const endsAt: Date | null = r.has_sub ? r.period_end : r.status === 'TRIAL' ? r.trial_ends_at : null;
    const phase = subscriptionPhase(new Date(), endsAt, { graceDays: r.billing_cfg?.graceDays ?? DEFAULT_LIFECYCLE.graceDays, lockDays: r.billing_cfg?.lockDays ?? DEFAULT_LIFECYCLE.lockDays }).phase;
    return {
      billing: { endsAt, phase, daysLeft: endsAt ? Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000) : null },
      id: r.id, slug: r.slug, name: r.name, status: r.status, timezone: r.timezone, features,
      limits: resolveLimits(r.limits, r.limit_overrides),
      labels: resolveLabels(r.settings?.labels),
      branding: resolveBranding(r.settings?.branding, features['white_label'] === true),
    };
  });
}

/**
 * Host thật của request. Khi Next dựng lại trang đích sau một server action (redirect), header `host` bị đổi thành
 * localhost:PORT còn host gốc nằm ở `x-forwarded-host`; sau reverse proxy cũng vậy. Cookie phiên gắn theo host và
 * dữ liệu vẫn bị chặn bởi kiểm tra tenantId của phiên, nên việc tin header này không mở thêm đường truy cập.
 */
export const hostOf = (h: { get(name: string): string | null }) => h.get('x-forwarded-host')?.split(',')[0]?.trim() || h.get('host') || '';

/** Tenant của request hiện tại (cache trong một request). */
export const getTenant = cache(async (): Promise<TenantInfo | null> => {
  const h = await headers();
  return tenantFromHost(hostOf(h));
});
