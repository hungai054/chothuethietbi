import { randomBytes } from 'node:crypto';
import { withTenantId, MemoryStorage, type ServiceCtx } from '../src';
import { IMPERSONATION_PERMISSIONS, permissionsFor, type DepositHook, type Permission, type PricingHook, type TenantRole } from '@rentpro/core';
import { FEATURE_KEYS, resolveFeatures, resolveLimits, type FeatureKey, type KeyRing, type Limits } from '@rentpro/tenancy';
import type { TestDb } from './helpers';

export interface Opts {
  role?: TenantRole; off?: FeatureKey[]; limits?: Partial<Limits>; status?: string; storage?: MemoryStorage;
  ring?: KeyRing; hook?: PricingHook; depositHook?: DepositHook; support?: boolean; perms?: Permission[]; timezone?: string;
}

export const ring: KeyRing = { current: 'k1', keys: { k1: randomBytes(32) } };
export const storage = new MemoryStorage();

let seq = 0;
export async function mkTenant(t: TestDb, planCode = 'p', status = 'ACTIVE') {
  const slug = `t${Date.now().toString(36)}-${++seq}`;
  const plan = (await t.admin.query('SELECT id FROM plan WHERE code=$1', [planCode])).rows[0].id;
  const id = (await t.admin.query('INSERT INTO tenant(slug,name,plan_id,status) VALUES ($1,$1,$2,$3) RETURNING id', [slug, plan, status])).rows[0].id as string;
  await t.admin.query("INSERT INTO branch(tenant_id,name) VALUES ($1,'Chi nhánh chính')", [id]);
  return id;
}

export function runAs<T>(t: TestDb, tenantId: string, o: Opts, fn: (c: ServiceCtx) => Promise<T>): Promise<T> {
  const on = Object.fromEntries(FEATURE_KEYS.filter((k) => !o.off?.includes(k)).map((k) => [k, true]));
  return withTenantId(t.app, tenantId, (db) => fn({
    db, tenantId, tenantStatus: o.status ?? 'ACTIVE', userId: null,
    permissions: o.support ? new Set(IMPERSONATION_PERMISSIONS) : new Set(o.perms ?? permissionsFor(o.role ?? 'OWNER')),
    features: resolveFeatures({ planFeatures: on, overrides: {} }), limits: resolveLimits(o.limits ?? {}, {}),
    keyRing: o.ring ?? ring, storage: o.storage ?? storage, pricingHook: o.hook, depositHook: o.depositHook, timezone: o.timezone,
  }));
}

// Ảnh giả có chữ ký file hợp lệ
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3]);
export const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5, 6, 7, 8]);

/** PNG giả đủ lớn (chữ ký "có nét") và PNG giả quá nhỏ (chữ ký trống) */
export const SIGNATURE = (() => { const b = new Uint8Array(600); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); for (let i = 8; i < b.length; i++) b[i] = (i * 31) % 251; return b; })();
