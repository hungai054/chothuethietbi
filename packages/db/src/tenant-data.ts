import JSZip from 'jszip';
import type pg from 'pg';
import { EXPORT_SHEETS, collectStoragePaths, exportReadme, exportableRow, redactSecrets, tablesToXlsx, type SheetData } from '@rentpro/core';
import { PlatformError, platformAudit, platformTx, type Actor } from './platform';
import type { StorageAdapter } from './storage';

/**
 * Xuất toàn bộ dữ liệu của một cửa hàng (ZIP: JSON + Excel + file đính kèm) và xóa cửa hàng (xóa mềm, giữ 30 ngày, có thể khôi phục;
 * xóa hẳn chỉ sau hạn giữ và có xác nhận). Chạy bằng role quản trị; nơi gọi phải kiểm quyền và lấy tenantId từ nguồn tin cậy.
 */
type Pool = pg.Pool;

export const RETENTION_DAYS = 30;
const MAX_ROWS_PER_TABLE = 200_000;
/** Bảng nội bộ của nền tảng, không thuộc dữ liệu của khách */
const EXCLUDED = new Set(['platform_email', 'platform_audit', 'renewal_reminder']);

async function tenantTables(db: Pool | pg.PoolClient): Promise<string[]> {
  const r = await db.query(
    `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
     WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' ORDER BY c.table_name`);
  return r.rows.map((x: { table_name: string }) => x.table_name).filter((n: string) => /^[a-z0-9_]+$/.test(n) && !EXCLUDED.has(n));
}

export interface ExportStats { tables: number; rows: number; files: number; missingFiles: number; truncated: string[]; bytes: number }

export async function exportTenantZip(pool: Pool, tenantId: string, opts: { storage?: StorageAdapter; actor?: Actor; now?: Date } = {}): Promise<{ zip: Buffer; filename: string; stats: ExportStats }> {
  const now = opts.now ?? new Date();
  const tenant = (await pool.query('SELECT * FROM tenant WHERE id=$1', [tenantId])).rows[0];
  if (!tenant) throw new PlatformError('Không tìm thấy cửa hàng.');
  const zip = new JSZip();
  const stats: ExportStats = { tables: 0, rows: 0, files: 0, missingFiles: 0, truncated: [], bytes: 0 };
  const paths = new Set<string>();
  const sheets: SheetData[] = [];

  const tenantJson = { ...exportableRow(tenant), settings: redactSecrets(tenant.settings), feature_overrides: tenant.feature_overrides, limit_overrides: tenant.limit_overrides };
  zip.file('data/_tenant.json', JSON.stringify(tenantJson, null, 1));
  collectStoragePaths(tenantId, tenantJson, paths);

  for (const table of await tenantTables(pool)) {
    const rows = (await pool.query(`SELECT * FROM "${table}" WHERE tenant_id=$1 LIMIT ${MAX_ROWS_PER_TABLE + 1}`, [tenantId])).rows as Record<string, unknown>[];
    if (rows.length > MAX_ROWS_PER_TABLE) { rows.length = MAX_ROWS_PER_TABLE; stats.truncated.push(table); }
    if (rows.length === 0) continue;
    // Mọi bảng đi qua redactSecrets: cột jsonb cấu hình (nếu có) không được làm lộ bí mật nhà cung cấp
    const safe = rows.map(exportableRow).map((r) => redactSecrets(r) as Record<string, unknown>);
    zip.file(`data/${table}.json`, JSON.stringify(safe));
    for (const r of safe) collectStoragePaths(tenantId, r, paths);
    stats.tables++;
    stats.rows += safe.length;
    if (EXPORT_SHEETS[table]) sheets.push({ name: EXPORT_SHEETS[table]!, rows: safe });
  }

  zip.file('tong-hop.xlsx', await tablesToXlsx(sheets.length ? sheets : [{ name: 'Trống', rows: [] }]));

  if (opts.storage) {
    for (const p of paths) {
      const f = await opts.storage.get(p).catch(() => null);
      if (!f) { stats.missingFiles++; continue; }
      zip.file(`files/${p.slice(`tenants/${tenantId}/`.length)}`, f.data);
      stats.files++;
    }
  }
  zip.file('README.txt', exportReadme({ tenantName: tenant.name, slug: tenant.slug, exportedAt: now, tables: stats.tables, rows: stats.rows, files: stats.files, missingFiles: stats.missingFiles, truncated: stats.truncated }));
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  stats.bytes = buf.length;
  const day = now.toISOString().slice(0, 10);
  await platformAudit(pool, opts.actor ?? { id: '00000000-0000-0000-0000-000000000000', email: 'system' }, 'tenant.export', tenantId, { tables: stats.tables, rows: stats.rows, files: stats.files, bytes: stats.bytes });
  return { zip: buf, filename: `rentpro-${tenant.slug}-${day}.zip`, stats };
}

// ===== Xóa cửa hàng =====
export async function softDeleteTenant(pool: Pool, actor: Actor, tenantId: string, i: { confirmSlug: string; reason: string }, now = new Date()): Promise<{ purgeAfter: Date }> {
  if (i.reason.trim().length < 5) throw new PlatformError('Nhập lý do xóa (ít nhất 5 ký tự).');
  await platformTx(pool, async (db) => {
    const t = (await db.query('SELECT slug, status, deleted_at FROM tenant WHERE id=$1 FOR UPDATE', [tenantId])).rows[0];
    if (!t || t.deleted_at) throw new PlatformError('Không tìm thấy cửa hàng.');
    if (i.confirmSlug.trim() !== t.slug) throw new PlatformError('Địa chỉ cửa hàng nhập để xác nhận không khớp. Chưa xóa gì cả.');
    await db.query("UPDATE tenant SET status='DELETED', deleted_at=$2, locked_by_billing=false WHERE id=$1", [tenantId, now]);
    // Phiên hỗ trợ đang mở bị đóng
    await db.query('UPDATE support_access SET ended_at=$2 WHERE tenant_id=$1 AND ended_at IS NULL', [tenantId, now]);
    await platformAudit(db, actor, 'tenant.delete', tenantId, { slug: t.slug, from: t.status }, i.reason.trim());
  });
  return { purgeAfter: new Date(now.getTime() + RETENTION_DAYS * 86_400_000) };
}

export interface DeletedTenant { id: string; slug: string; name: string; deleted_at: Date; purge_after: Date; can_purge: boolean }

export async function listDeletedTenants(pool: Pool, now = new Date()): Promise<DeletedTenant[]> {
  const r = await pool.query(
    `SELECT id, slug, name, deleted_at, deleted_at + make_interval(days => $1) AS purge_after, (deleted_at + make_interval(days => $1) <= $2) AS can_purge
     FROM tenant WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`, [RETENTION_DAYS, now]);
  return r.rows;
}

/** Khôi phục trong thời hạn giữ. Về trạng thái tạm khóa để quản trị viên chủ động mở lại sau khi kiểm tra. */
export async function restoreTenant(pool: Pool, actor: Actor, tenantId: string): Promise<void> {
  await platformTx(pool, async (db) => {
    const t = (await db.query('SELECT slug, deleted_at FROM tenant WHERE id=$1 FOR UPDATE', [tenantId])).rows[0];
    if (!t?.deleted_at) throw new PlatformError('Cửa hàng này không ở trạng thái đã xóa.');
    await db.query("UPDATE tenant SET status='SUSPENDED', deleted_at=NULL, locked_by_billing=false WHERE id=$1", [tenantId]);
    await platformAudit(db, actor, 'tenant.restore', tenantId, { slug: t.slug });
  });
}

/** Xóa HẲN dữ liệu của một cửa hàng đã xóa mềm quá hạn giữ. Không thể hoàn tác. */
export async function purgeTenant(pool: Pool, actor: Actor, tenantId: string, i: { confirmSlug: string; storage?: StorageAdapter }, now = new Date()): Promise<{ tables: number; rows: number; files: number }> {
  const t = (await pool.query('SELECT slug, deleted_at FROM tenant WHERE id=$1', [tenantId])).rows[0];
  if (!t?.deleted_at) throw new PlatformError('Chỉ xóa hẳn được cửa hàng đã xóa mềm.');
  if (new Date(t.deleted_at).getTime() + RETENTION_DAYS * 86_400_000 > now.getTime()) throw new PlatformError(`Chưa hết thời hạn giữ ${RETENTION_DAYS} ngày.`);
  if (i.confirmSlug.trim() !== t.slug) throw new PlatformError('Địa chỉ cửa hàng nhập để xác nhận không khớp.');

  const paths = new Set<string>();
  const out = { tables: 0, rows: 0, files: 0 };
  await platformTx(pool, async (db) => {
    const all = await tenantTables(db);
    collectStoragePaths(tenantId, (await db.query('SELECT settings FROM tenant WHERE id=$1', [tenantId])).rows[0]?.settings, paths); // logo, favicon nằm trong cấu hình
    for (const table of all) {
      const rows = (await db.query(`SELECT * FROM "${table}" WHERE tenant_id=$1`, [tenantId])).rows;
      for (const r of rows) collectStoragePaths(tenantId, r, paths);
    }
    // Xóa con trước cha: thử từng bảng trong savepoint, bảng bị ràng buộc khóa ngoại thì để vòng sau
    let pending = [...all];
    for (let pass = 0; pass < all.length + 2 && pending.length; pass++) {
      const next: string[] = [];
      for (const table of pending) {
        await db.query('SAVEPOINT purge');
        try {
          const r = await db.query(`DELETE FROM "${table}" WHERE tenant_id=$1`, [tenantId]);
          await db.query('RELEASE SAVEPOINT purge');
          out.rows += r.rowCount ?? 0;
          out.tables++;
        } catch (e) {
          await db.query('ROLLBACK TO SAVEPOINT purge');
          if ((e as { code?: string }).code !== '23503') throw e;
          next.push(table);
        }
      }
      if (next.length === pending.length) throw new PlatformError(`Không xóa được do ràng buộc dữ liệu ở: ${next.join(', ')}.`);
      pending = next;
    }
    await db.query('DELETE FROM tenant WHERE id=$1', [tenantId]);
    await platformAudit(db, actor, 'tenant.purge', null, { slug: t.slug, ...out });
  });
  if (i.storage) for (const p of paths) { await i.storage.delete(p).catch(() => undefined); out.files++; }
  return out;
}
