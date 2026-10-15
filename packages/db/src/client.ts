import pg from 'pg';
import { currentTenant } from '@rentpro/tenancy';

export type Db = pg.PoolClient;

export function createPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error('Thiếu DATABASE_URL');
  const pool = new pg.Pool({ connectionString: url });
  // Kết nối RỖI bị máy chủ đóng (khởi động lại DB, failover, hết hạn mạng) phát sự kiện 'error' trên pool; không có handler thì cả tiến trình sập.
  // Pool tự bỏ kết nối hỏng và lần truy vấn sau sẽ mở kết nối mới.
  pool.on('error', (e) => console.warn('[db] kết nối rỗi bị đóng:', e.message));
  return pool;
}

/**
 * Chạy fn trong một transaction với app.tenant_id đã đặt (SET LOCAL qua set_config(..., true)).
 * Ngoài hàm này, role ứng dụng không đọc/ghi được bảng nghiệp vụ nào (RLS).
 */
export async function withTenantId<T>(pool: pg.Pool, tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('tenantId không hợp lệ');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    db.release();
  }
}

/** Lấy tenant từ AsyncLocalStorage của request. */
export const withTenant = <T>(pool: pg.Pool, fn: (db: Db) => Promise<T>) =>
  withTenantId(pool, currentTenant().tenantId, fn);

export async function resolveTenant(pool: pg.Pool, slug: string, domain?: string) {
  const r = await pool.query<{ id: string; status: string }>('SELECT * FROM resolve_tenant($1, $2)', [slug, domain ?? null]);
  return r.rows[0] ?? null;
}

/** Bắt lỗi trùng lịch của exclusion constraint và đổi thành thông báo tiếng Việt. */
export class BookingConflictError extends Error {
  constructor() {
    super('Thiết bị đã được đặt hoặc đang bảo trì trong khoảng thời gian này. Vui lòng chọn thiết bị khác hoặc khung giờ khác.');
    this.name = 'BookingConflictError';
  }
}
export function translateDbError(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string };
  if (err?.code === '23P01' && err.constraint === 'unit_allocation_no_overlap') return new BookingConflictError();
  return e;
}
