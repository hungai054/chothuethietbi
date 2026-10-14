import { DomainError, checkDomain, makeVerifyToken, normalizeDomain, verifyRecordName, type DnsResolver } from '@rentpro/core';
import { NotFoundError, ValidationError, audit, guard, type ServiceCtx } from './service';

type Row = Record<string, any>;
export const MAX_DOMAINS = 3;

export interface DomainOpts {
  /** Tên miền nền tảng (VD rentpro.vn): cửa hàng không đăng ký chính nó hoặc subdomain của nó */
  platformBase?: string;
  /** Tên miền đích để khách trỏ CNAME về (VD custom.rentpro.vn) */
  cnameTarget?: string | null;
}

export interface DomainRow { id: string; domain: string; verified: boolean; verifyToken: string | null; txtName: string; createdAt: Date; verifiedAt: Date | null }

export async function listDomains(ctx: ServiceCtx): Promise<DomainRow[]> {
  guard(ctx, 'settings.manage', 'custom_domain');
  return (await ctx.db.query('SELECT * FROM tenant_domain ORDER BY created_at')).rows.map((r: Row) => ({
    id: r.id, domain: r.domain, verified: r.verified, verifyToken: r.verified ? null : r.verify_token, txtName: verifyRecordName(r.domain), createdAt: r.created_at, verifiedAt: r.verified_at,
  }));
}

export async function addDomain(ctx: ServiceCtx, raw: string, opts: DomainOpts = {}): Promise<string> {
  guard(ctx, 'settings.manage', 'custom_domain', { write: true });
  let domain: string;
  try { domain = normalizeDomain(raw, opts.platformBase); } catch (e) { if (e instanceof DomainError) throw new ValidationError(e.message); throw e; }
  if ((await ctx.db.query('SELECT count(*)::int n FROM tenant_domain').then((r) => r.rows[0].n)) >= MAX_DOMAINS) throw new ValidationError(`Mỗi cửa hàng tối đa ${MAX_DOMAINS} tên miền riêng.`);
  try {
    const r = await ctx.db.query('INSERT INTO tenant_domain(tenant_id, domain, verify_token) VALUES ($1,$2,$3) RETURNING id', [ctx.tenantId, domain, makeVerifyToken()]);
    await audit(ctx, 'domain.add', 'tenant_domain', r.rows[0].id, { domain });
    return r.rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ValidationError(`Tên miền ${domain} đã được thêm hoặc đang được cửa hàng khác sử dụng.`);
    throw e;
  }
}

/** Kiểm tra DNS rồi đánh dấu đã xác minh. `dns` truyền vào được để test; mặc định dùng bộ phân giải hệ thống. */
export async function verifyDomain(ctx: ServiceCtx, id: string, dns: DnsResolver, opts: DomainOpts = {}): Promise<{ ok: boolean; message: string }> {
  guard(ctx, 'settings.manage', 'custom_domain', { write: true });
  const d = (await ctx.db.query('SELECT * FROM tenant_domain WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!d) throw new NotFoundError('tên miền');
  if (d.verified) return { ok: true, message: 'Tên miền đã được xác minh trước đó.' };
  const res = await checkDomain(d.domain, d.verify_token, opts.cnameTarget ?? null, dns);
  if (!res.ok) return { ok: false, message: res.message };
  try {
    await ctx.db.query('UPDATE tenant_domain SET verified=true, verified_at=now() WHERE id=$1', [id]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return { ok: false, message: `${d.domain} đã được một cửa hàng khác xác minh trước.` };
    throw e;
  }
  await audit(ctx, 'domain.verify', 'tenant_domain', id, { domain: d.domain });
  return { ok: true, message: res.message };
}

export async function removeDomain(ctx: ServiceCtx, id: string): Promise<void> {
  guard(ctx, 'settings.manage', 'custom_domain', { write: true });
  const r = await ctx.db.query('DELETE FROM tenant_domain WHERE id=$1 RETURNING domain', [id]);
  if (!r.rowCount) throw new NotFoundError('tên miền');
  await audit(ctx, 'domain.remove', 'tenant_domain', id, { domain: r.rows[0].domain });
}
