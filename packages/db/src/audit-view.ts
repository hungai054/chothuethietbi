import { localDateKey, zonedTimeToUtc } from '@rentpro/core';
import { ValidationError, audit, guard, type ServiceCtx } from './service';

/** Xem nhật ký thao tác của cửa hàng (bảng `audit_log`, chỉ thêm). Cần quyền `audit.view`; mỗi lần XUẤT được ghi lại. */
const FEATURE = 'audit.log' as const;
export const AUDIT_PAGE_MAX = 200;
export const AUDIT_EXPORT_MAX = 20_000;

export interface AuditFilter { action?: string; entity?: string; userId?: string; q?: string; from?: string; to?: string; page?: number; pageSize?: number }
export interface AuditRow { id: number; at: Date; userId: string | null; userName: string | null; action: string; entity: string | null; entityId: string | null; data: Record<string, unknown> }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bounds(ctx: ServiceCtx, from?: string, to?: string): { from: Date | null; to: Date | null } {
  const tz = ctx.timezone ?? 'Asia/Ho_Chi_Minh';
  const day = (s: string, label: string) => {
    if (!DAY.test(s)) throw new ValidationError(`${label} phải có dạng YYYY-MM-DD.`);
    const d = zonedTimeToUtc(`${s}T00:00`, tz);
    if (!d) throw new ValidationError(`${label} không hợp lệ.`);
    return d;
  };
  const f = from ? day(from, 'Từ ngày') : null;
  // "Đến ngày" tính hết ngày đó theo múi giờ cửa hàng
  const t = to ? day(new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), 'Đến ngày') : null;
  if (to) day(to, 'Đến ngày');
  if (f && t && f >= t) throw new ValidationError('Khoảng ngày không hợp lệ: "Từ ngày" phải trước hoặc bằng "Đến ngày".');
  return { from: f, to: t };
}

function where(ctx: ServiceCtx, f: AuditFilter) {
  if (f.userId && !UUID.test(f.userId)) throw new ValidationError('Người dùng không hợp lệ.');
  if ((f.q?.length ?? 0) > 80) throw new ValidationError('Từ khóa tối đa 80 ký tự.');
  const b = bounds(ctx, f.from, f.to);
  return {
    sql: `($1::text IS NULL OR a.action = $1 OR a.action LIKE $1 || '.%') AND ($2::text IS NULL OR a.entity = $2) AND ($3::uuid IS NULL OR a.user_id = $3)
      AND ($4::timestamptz IS NULL OR a.created_at >= $4) AND ($5::timestamptz IS NULL OR a.created_at < $5)
      AND ($6::text IS NULL OR a.entity_id = $6 OR a.data::text ILIKE '%' || $6 || '%')`,
    args: [f.action?.trim() || null, f.entity?.trim() || null, f.userId || null, b.from, b.to, f.q?.trim() || null],
  };
}

const toRow = (r: Record<string, any>): AuditRow => ({
  id: Number(r.id), at: r.created_at, userId: r.user_id, userName: r.user_name, action: r.action, entity: r.entity, entityId: r.entity_id, data: r.data ?? {},
});
const SELECT = `a.id, a.created_at, a.user_id, u.name AS user_name, a.action, a.entity, a.entity_id, a.data FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id`;

export async function listAuditLog(ctx: ServiceCtx, f: AuditFilter = {}): Promise<{ rows: AuditRow[]; total: number }> {
  guard(ctx, 'audit.view', FEATURE);
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), AUDIT_PAGE_MAX);
  const offset = (Math.max(f.page ?? 1, 1) - 1) * pageSize;
  const w = where(ctx, f);
  const total = (await ctx.db.query(`SELECT count(*)::int AS n FROM audit_log a WHERE ${w.sql}`, w.args)).rows[0].n as number;
  const { rows } = await ctx.db.query(`SELECT ${SELECT} WHERE ${w.sql} ORDER BY a.id DESC LIMIT ${pageSize} OFFSET ${offset}`, w.args);
  return { total, rows: rows.map(toRow) };
}

/** Các loại thao tác và đối tượng đã từng xuất hiện (cho ô lọc) */
export async function listAuditFacets(ctx: ServiceCtx): Promise<{ actions: string[]; entities: string[]; users: { id: string; name: string }[] }> {
  guard(ctx, 'audit.view', FEATURE);
  const actions = (await ctx.db.query('SELECT DISTINCT action FROM audit_log ORDER BY action LIMIT 500')).rows.map((r) => r.action as string);
  const entities = (await ctx.db.query('SELECT DISTINCT entity FROM audit_log WHERE entity IS NOT NULL ORDER BY entity LIMIT 200')).rows.map((r) => r.entity as string);
  const users = (await ctx.db.query('SELECT id, name FROM app_user ORDER BY name LIMIT 500')).rows.map((r) => ({ id: r.id as string, name: r.name as string }));
  return { actions, entities, users };
}

/** Xuất nhật ký theo bộ lọc (tối đa AUDIT_EXPORT_MAX dòng, mới nhất trước). Việc xuất cũng được ghi nhật ký. */
export async function exportAuditLog(ctx: ServiceCtx, f: AuditFilter = {}): Promise<{ rows: AuditRow[]; truncated: boolean }> {
  guard(ctx, 'audit.view', FEATURE);
  guard(ctx, 'data.export', FEATURE);
  const w = where(ctx, f);
  const { rows } = await ctx.db.query(`SELECT ${SELECT} WHERE ${w.sql} ORDER BY a.id DESC LIMIT ${AUDIT_EXPORT_MAX + 1}`, w.args);
  await audit(ctx, 'audit.export', 'audit_log', 'export', { filter: { ...f, page: undefined, pageSize: undefined }, rows: Math.min(rows.length, AUDIT_EXPORT_MAX) });
  return { rows: rows.slice(0, AUDIT_EXPORT_MAX).map(toRow), truncated: rows.length > AUDIT_EXPORT_MAX };
}
