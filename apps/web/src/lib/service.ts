import { redirect } from 'next/navigation';
import { ForbiddenError, InvalidTransitionError } from '@rentpro/core';
import { resolve } from 'node:path';
import { LocalFsStorage, NotFoundError, ReadOnlyError, ValidationError, withTenantId, type ServiceCtx } from '@rentpro/db';
import { FeatureDisabledError, LimitExceededError, keyRingFromEnv } from '@rentpro/tenancy';
import { pool } from './db';
import { requireAppSession, type AppSession } from './session';

const g = globalThis as unknown as { __storage?: LocalFsStorage; __ring?: ReturnType<typeof keyRingFromEnv> };
// Thư mục lưu ảnh giấy tờ nằm NGOÀI thư mục public của web; production thay bằng adapter S3-compatible.
const storage = () => (g.__storage ??= new LocalFsStorage(process.env.STORAGE_DIR ?? resolve(process.cwd(), '../../.data/storage')));
const keyRing = () => (g.__ring ??= keyRingFromEnv());

/** Chạy một thao tác nghiệp vụ trong transaction của tenant hiện tại, với quyền/gói của người đăng nhập. */
export async function withService<T>(fn: (ctx: ServiceCtx, session: AppSession) => Promise<T>): Promise<T> {
  const s = await requireAppSession();
  return withTenantId(pool(), s.tenant.id, (db) =>
    fn({
      db, tenantId: s.tenant.id, tenantStatus: s.tenant.status, userId: s.support ? null : s.user.id,
      permissions: s.permissions, features: s.tenant.features, limits: s.tenant.limits,
      timezone: s.tenant.timezone, keyRing: keyRing(), storage: storage(),
    }, s),
  );
}

const USER_FACING = [ValidationError, NotFoundError, ReadOnlyError, ForbiddenError, FeatureDisabledError, LimitExceededError, InvalidTransitionError];

export const isUserError = (e: unknown): e is Error => USER_FACING.some((c) => e instanceof c);

const isRedirect = (e: unknown) =>
  typeof e === 'object' && e !== null && 'digest' in e && String((e as { digest: unknown }).digest).startsWith('NEXT_REDIRECT');

/** Lỗi nghiệp vụ → quay lại trang với thông báo tiếng Việt; lỗi lạ thì ném tiếp (không lộ chi tiết cho người dùng). */
export async function run(failTo: string, fn: () => Promise<string | void>): Promise<never> {
  let okTo: string | void;
  try {
    okTo = await fn();
  } catch (e) {
    if (isRedirect(e)) throw e;
    if (isUserError(e)) redirect(`${failTo}${failTo.includes('?') ? '&' : '?'}error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  return redirect(okTo || failTo);
}

/** Dùng cho action trả dữ liệu (không chuyển trang). */
export async function safe<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (isUserError(e)) return { ok: false, error: e.message };
    throw e;
  }
}
