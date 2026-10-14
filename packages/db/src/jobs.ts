import type pg from 'pg';
import { PERMISSIONS, signToken } from '@rentpro/core';
import { resolveFeatures, resolveLimits, type KeyRing } from '@rentpro/tenancy';
import { withTenantId } from './client';
import { releaseExpiredHolds } from './booking';
import { dispatchQueued, scanReminders, type DispatchResult, type NotifyDeps, type ScanResult } from './notify';
import type { ServiceCtx } from './service';
import type { StorageAdapter } from './storage';

export interface JobDeps {
  /** Kết nối role ứng dụng (RLS): mọi việc nghiệp vụ chạy qua đây, trong ngữ cảnh một tenant */
  appPool: pg.Pool;
  /** Kết nối role quản trị: CHỈ dùng để liệt kê tenant cần chạy */
  adminPool: pg.Pool;
  keyRing?: KeyRing;
  storage?: StorageAdapter;
  notify?: NotifyDeps;
  /** Địa chỉ gốc của cửa hàng theo slug (VD http://demo.localhost:3000) để dựng liên kết thanh toán */
  publicUrl?: (slug: string) => string | null;
  /** Bí mật ký liên kết thanh toán công khai */
  paySecret?: string;
}

export const PAY_LINK_TTL_SECONDS = 14 * 86_400;

export interface JobTenant { id: string; slug: string; name: string; status: string; timezone: string; features: Record<string, boolean>; limits: Record<string, number | null> }

/** Tenant đang hoạt động (dùng thử hoặc trả phí). Tenant chỉ đọc/tạm khóa/đã xóa không chạy tác vụ ghi. */
export async function listRunnableTenants(adminPool: pg.Pool): Promise<JobTenant[]> {
  const { rows } = await adminPool.query(
    `SELECT t.id, t.slug, t.name, t.status, t.timezone, t.feature_overrides, t.limit_overrides, p.features, p.limits
     FROM tenant t JOIN plan p ON p.id = t.plan_id WHERE t.deleted_at IS NULL AND t.status IN ('TRIAL','ACTIVE') ORDER BY t.created_at`);
  return rows.map((r) => ({
    id: r.id, slug: r.slug, name: r.name, status: r.status, timezone: r.timezone,
    features: resolveFeatures({ planFeatures: r.features, overrides: r.feature_overrides }) as unknown as Record<string, boolean>,
    limits: resolveLimits(r.limits, r.limit_overrides) as unknown as Record<string, number | null>,
  }));
}

export interface TenantJobResult { tenantId: string; holdsReleased: number; scan: ScanResult | null; dispatch: DispatchResult | null; errors: string[] }

/** Một bước của tác vụ nền: giao dịch riêng, khóa advisory để hai worker không chạy trùng, ghi nhật ký kết quả, lỗi không lan sang bước khác. */
async function step<T>(deps: JobDeps, t: JobTenant, name: string, now: Date, fn: (ctx: ServiceCtx) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const started = new Date();
  let result: { ok: true; value: T } | { ok: false; error: string };
  try {
    const value = await withTenantId(deps.appPool, t.id, async (db) => {
      const lock = await db.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [`job:${name}:${t.id}`]);
      if (!lock.rows[0].ok) return undefined;
      return fn({
        db, tenantId: t.id, tenantStatus: t.status, userId: null, permissions: new Set(PERMISSIONS),
        features: t.features as never, limits: t.limits as never, timezone: t.timezone, keyRing: deps.keyRing, storage: deps.storage,
      });
    });
    result = { ok: true, value: value as T };
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    await withTenantId(deps.appPool, t.id, (db) =>
      db.query('INSERT INTO job_run(tenant_id,name,started_at,ok,detail) VALUES ($1,$2,$3,$4,$5)', [t.id, name, started, result.ok, JSON.stringify(result.ok ? { result: result.value ?? null } : { error: result.error })]));
  } catch {
    // không ghi được nhật ký thì thôi, không làm hỏng vòng chạy
  }
  void now;
  return result;
}

export async function runTenantJobs(deps: JobDeps, t: JobTenant, now = new Date()): Promise<TenantJobResult> {
  const out: TenantJobResult = { tenantId: t.id, holdsReleased: 0, scan: null, dispatch: null, errors: [] };
  const holds = await step(deps, t, 'holds.release', now, (ctx) => releaseExpiredHolds(ctx));
  if (holds.ok) out.holdsReleased = holds.value ?? 0; else out.errors.push(`holds.release: ${holds.error}`);

  const base = deps.publicUrl?.(t.slug) ?? null;
  const payLink = base && deps.paySecret ? (bookingId: string) => `${base}/pay/${signToken({ t: t.id, b: bookingId }, deps.paySecret!, PAY_LINK_TTL_SECONDS)}` : undefined;
  const scan = await step(deps, t, 'reminders.scan', now, (ctx) => scanReminders(ctx, now, { payLink }));
  if (scan.ok) out.scan = scan.value ?? null; else out.errors.push(`reminders.scan: ${scan.error}`);

  const send = await step(deps, t, 'notifications.dispatch', now, (ctx) => dispatchQueued(ctx, now, deps.notify));
  if (send.ok) out.dispatch = send.value ?? null; else out.errors.push(`notifications.dispatch: ${send.error}`);
  return out;
}

/** Một vòng cho mọi tenant đang hoạt động. Lỗi của tenant này không chặn tenant khác. */
export async function runAllJobs(deps: JobDeps, now = new Date()): Promise<TenantJobResult[]> {
  const out: TenantJobResult[] = [];
  for (const t of await listRunnableTenants(deps.adminPool)) out.push(await runTenantJobs(deps, t, now));
  return out;
}

/** Xóa nhật ký tác vụ cũ để bảng không phình mãi. */
export async function pruneJobRuns(adminPool: pg.Pool, keepDays = 30): Promise<number> {
  const r = await adminPool.query(`DELETE FROM job_run WHERE finished_at < now() - make_interval(days => $1)`, [keepDays]);
  return r.rowCount ?? 0;
}
