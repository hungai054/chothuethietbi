import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { hashPassword, validateImpersonationRequest } from '@rentpro/core';
import { LIMIT_KEYS, isFeatureKey, type FeatureMap, type Limits } from '@rentpro/tenancy';

/** Mọi hàm ở đây nhận pool của role rentpro_admin (BYPASSRLS). Chỉ apps/admin được gọi. */
type Pool = pg.Pool;

export interface Actor {
  id: string;
  email: string;
}

export class PlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformError';
  }
}

async function audit(db: pg.PoolClient | Pool, actor: Actor, action: string, tenantId: string | null, data: object, reason?: string) {
  await db.query('INSERT INTO platform_audit(actor_id, tenant_id, action, reason, data) VALUES ($1,$2,$3,$4,$5)', [
    actor.id, tenantId, action, reason ?? null, JSON.stringify({ actor: actor.email, ...data }),
  ]);
}

async function tx<T>(pool: Pool, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
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

// ===== Người dùng nền tảng =====
export interface PlatformUser {
  id: string; email: string; password_hash: string; role: 'SUPER_ADMIN' | 'SUPPORT' | 'SALES';
  totp_secret: string | null; totp_enabled: boolean; totp_last_step: string | null; active: boolean;
}

export async function findPlatformUser(pool: Pool, email: string): Promise<PlatformUser | null> {
  const r = await pool.query('SELECT * FROM platform_user WHERE email = $1', [email.toLowerCase()]);
  return r.rows[0] ?? null;
}

export async function getPlatformUser(pool: Pool, id: string): Promise<PlatformUser | null> {
  const r = await pool.query('SELECT * FROM platform_user WHERE id = $1 AND active', [id]);
  return r.rows[0] ?? null;
}

export async function storeTotpSecret(pool: Pool, userId: string, secret: string) {
  await pool.query('UPDATE platform_user SET totp_secret=$2, totp_enabled=false WHERE id=$1', [userId, secret]);
}

/** Ghi lại khóa đã mã hóa mà KHÔNG đổi trạng thái bật 2FA (dùng khi mã hóa lại khóa cũ lưu chữ thường). */
export async function resealTotpSecret(pool: Pool, userId: string, sealed: string) {
  await pool.query('UPDATE platform_user SET totp_secret=$2 WHERE id=$1', [userId, sealed]);
}

export async function confirmTotp(pool: Pool, userId: string, step: number) {
  await pool.query('UPDATE platform_user SET totp_enabled=true, totp_last_step=$2 WHERE id=$1', [userId, step]);
}

export async function recordTotpStep(pool: Pool, userId: string, step: number) {
  await pool.query('UPDATE platform_user SET totp_last_step=$2 WHERE id=$1', [userId, step]);
}

// ===== Khách hàng (tenant) =====
export interface TenantRow {
  id: string; slug: string; name: string; status: string; plan_code: string; plan_name: string;
  trial_ends_at: Date | null; created_at: Date; users: number; equipment: number; bookings_30d: number;
  feature_overrides: FeatureMap; limit_overrides: Partial<Limits>; notes: string | null;
}

export async function listTenants(pool: Pool, f: { q?: string; status?: string; plan?: string } = {}): Promise<TenantRow[]> {
  const r = await pool.query(
    `SELECT t.id, t.slug, t.name, t.status, p.code AS plan_code, p.name AS plan_name, t.trial_ends_at, t.created_at,
            t.feature_overrides, t.limit_overrides, t.notes,
            (SELECT count(*)::int FROM app_user u WHERE u.tenant_id = t.id AND u.active) AS users,
            (SELECT count(*)::int FROM equipment_unit e WHERE e.tenant_id = t.id AND e.deleted_at IS NULL) AS equipment,
            (SELECT count(*)::int FROM booking b WHERE b.tenant_id = t.id AND b.created_at > now() - interval '30 days') AS bookings_30d
     FROM tenant t JOIN plan p ON p.id = t.plan_id
     WHERE t.deleted_at IS NULL
       AND ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%')
       AND ($2::text IS NULL OR t.status = $2)
       AND ($3::text IS NULL OR p.code = $3)
     ORDER BY t.created_at DESC`,
    [f.q || null, f.status || null, f.plan || null],
  );
  return r.rows;
}

export async function getTenantDetail(pool: Pool, id: string): Promise<TenantRow | null> {
  const all = await listTenants(pool);
  return all.find((t) => t.id === id) ?? null;
}

export interface CreateTenantInput {
  slug: string; name: string; planCode: string; ownerEmail: string; ownerName: string; trialDays?: number;
}

/** Trả về mật khẩu tạm của chủ cửa hàng (sẽ gửi trong email mời; không lưu dạng rõ). */
export async function createTenant(pool: Pool, actor: Actor, input: CreateTenantInput) {
  const tempPassword = `Tmp-${randomBytes(9).toString('base64url')}1`;
  const hash = await hashPassword(tempPassword);
  const { tenantId } = await provisionTenant(pool, actor, input, hash);
  return { tenantId, tempPassword };
}

/** Tạo tenant với mật khẩu chủ cửa hàng đã băm sẵn (dùng cho đăng ký tự phục vụ, nơi chủ tự chọn mật khẩu). */
export async function provisionTenant(pool: Pool, actor: Actor, input: CreateTenantInput, passwordHash: string) {
  const hash = passwordHash;
  return tx(pool, async (db) => {
    const plan = (await db.query('SELECT id FROM plan WHERE code=$1', [input.planCode])).rows[0];
    if (!plan) throw new PlatformError(`Không có gói "${input.planCode}".`);
    let tenantId: string;
    try {
      tenantId = (await db.query(
        `INSERT INTO tenant(slug, name, plan_id, status, trial_ends_at)
         VALUES ($1,$2,$3,'TRIAL', now() + make_interval(days => COALESCE($4::int, (SELECT (value->>'trialDays')::int FROM platform_setting WHERE key='billing'), 14))) RETURNING id`,
        [input.slug, input.name, plan.id, input.trialDays ?? null],
      )).rows[0].id;
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === '23505') throw new PlatformError('Tên miền con (slug) đã được dùng.');
      if (err.code === '23514') throw new PlatformError('Slug chỉ gồm chữ thường, số, dấu gạch ngang (2–41 ký tự).');
      throw e;
    }
    await db.query(`INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,$2,$3,$4,'OWNER')`,
      [tenantId, input.ownerEmail.toLowerCase(), input.ownerName, hash]);
    await db.query(`INSERT INTO branch(tenant_id,name) VALUES ($1,'Chi nhánh chính')`, [tenantId]);
    await db.query(`INSERT INTO subscription_event(tenant_id,kind,plan_code) VALUES ($1,'TRIAL_START',$2)`, [tenantId, input.planCode]);
    await audit(db, actor, 'tenant.create', tenantId, { slug: input.slug, plan: input.planCode });
    return { tenantId };
  });
}

export async function changePlan(pool: Pool, actor: Actor, tenantId: string, planCode: string) {
  await tx(pool, async (db) => {
    const plan = (await db.query('SELECT id FROM plan WHERE code=$1', [planCode])).rows[0];
    if (!plan) throw new PlatformError(`Không có gói "${planCode}".`);
    const old = (await db.query('SELECT p.code FROM tenant t JOIN plan p ON p.id=t.plan_id WHERE t.id=$1', [tenantId])).rows[0];
    if (!old) throw new PlatformError('Không tìm thấy khách hàng.');
    await db.query('UPDATE tenant SET plan_id=$2 WHERE id=$1', [tenantId, plan.id]);
    await audit(db, actor, 'tenant.change_plan', tenantId, { from: old.code, to: planCode });
  });
}

export async function setFeatureOverrides(pool: Pool, actor: Actor, tenantId: string, overrides: Record<string, boolean | null>) {
  const clean: FeatureMap = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!isFeatureKey(k)) throw new PlatformError(`Khóa tính năng không hợp lệ: ${k}`);
    if (v !== null) clean[k] = v; // null = bỏ ghi đè, theo gói
  }
  await tx(pool, async (db) => {
    const r = await db.query('UPDATE tenant SET feature_overrides=$2 WHERE id=$1 RETURNING id', [tenantId, JSON.stringify(clean)]);
    if (!r.rowCount) throw new PlatformError('Không tìm thấy khách hàng.');
    await audit(db, actor, 'tenant.feature_overrides', tenantId, { overrides: clean });
  });
}

export async function setLimitOverrides(pool: Pool, actor: Actor, tenantId: string, overrides: Record<string, number | null | undefined>) {
  const clean: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(k)) throw new PlatformError(`Khóa giới hạn không hợp lệ: ${k}`);
    if (v === undefined) continue; // không ghi đè
    if (v !== null && (!Number.isInteger(v) || v < 0)) throw new PlatformError(`Giới hạn "${k}" phải là số nguyên không âm.`);
    clean[k] = v; // null = không giới hạn
  }
  await tx(pool, async (db) => {
    const r = await db.query('UPDATE tenant SET limit_overrides=$2 WHERE id=$1 RETURNING id', [tenantId, JSON.stringify(clean)]);
    if (!r.rowCount) throw new PlatformError('Không tìm thấy khách hàng.');
    await audit(db, actor, 'tenant.limit_overrides', tenantId, { overrides: clean });
  });
}

export const SETTABLE_STATUSES = ['TRIAL', 'ACTIVE', 'READ_ONLY', 'SUSPENDED'] as const;

export async function setTenantStatus(pool: Pool, actor: Actor, tenantId: string, status: string, reason?: string) {
  if (!(SETTABLE_STATUSES as readonly string[]).includes(status)) throw new PlatformError('Trạng thái không hợp lệ.');
  await tx(pool, async (db) => {
    const old = (await db.query('SELECT status FROM tenant WHERE id=$1 AND deleted_at IS NULL', [tenantId])).rows[0];
    if (!old) throw new PlatformError('Không tìm thấy khách hàng.');
    // Đổi tay thì không còn là khóa do thuê bao: thanh toán/quét hết hạn sẽ không tự mở lại
    await db.query('UPDATE tenant SET status=$2, locked_by_billing=false WHERE id=$1', [tenantId, status]);
    await audit(db, actor, 'tenant.status', tenantId, { from: old.status, to: status }, reason);
  });
}

export async function setTenantNotes(pool: Pool, actor: Actor, tenantId: string, notes: string) {
  await pool.query('UPDATE tenant SET notes=$2 WHERE id=$1', [tenantId, notes]);
  await audit(pool, actor, 'tenant.notes', tenantId, {});
}

// ===== Đăng nhập thay =====
export async function startImpersonation(pool: Pool, actor: Actor, tenantId: string, reason: string, minutes: number) {
  const bad = validateImpersonationRequest(reason, minutes);
  if (bad) throw new PlatformError(bad);
  return tx(pool, async (db) => {
    const t = (await db.query("SELECT status FROM tenant WHERE id=$1 AND deleted_at IS NULL", [tenantId])).rows[0];
    if (!t) throw new PlatformError('Không tìm thấy khách hàng.');
    const r = await db.query(
      `INSERT INTO support_access(tenant_id, platform_user_id, platform_user_email, reason, expires_at)
       VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5)) RETURNING id, expires_at`,
      [tenantId, actor.id, actor.email, reason.trim(), minutes],
    );
    const { id, expires_at } = r.rows[0] as { id: string; expires_at: Date };
    await audit(db, actor, 'tenant.impersonate.start', tenantId, { supportAccessId: id, minutes }, reason.trim());
    // Tenant cũng thấy trong nhật ký của mình
    await db.query(`INSERT INTO audit_log(tenant_id, action, entity, entity_id, data) VALUES ($1,'support.access','support_access',$2,$3)`,
      [tenantId, id, JSON.stringify({ by: actor.email, reason: reason.trim(), expiresAt: expires_at })]);
    return { id, expiresAt: expires_at };
  });
}

export async function endImpersonation(pool: Pool, actor: Actor, supportAccessId: string) {
  await pool.query('UPDATE support_access SET ended_at = now() WHERE id=$1 AND ended_at IS NULL', [supportAccessId]);
  await audit(pool, actor, 'tenant.impersonate.end', null, { supportAccessId });
}

// ===== Số liệu kinh doanh (cơ bản) =====
export async function platformStats(pool: Pool) {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE t.status='ACTIVE')::int AS active,
            count(*) FILTER (WHERE t.status='TRIAL')::int AS trial,
            count(*) FILTER (WHERE t.status IN ('READ_ONLY','SUSPENDED'))::int AS inactive,
            COALESCE(sum(p.price_month) FILTER (WHERE t.status='ACTIVE'), 0)::bigint AS mrr
     FROM tenant t JOIN plan p ON p.id=t.plan_id WHERE t.deleted_at IS NULL`,
  );
  return r.rows[0] as { active: number; trial: number; inactive: number; mrr: string };
}

export const listPlans = async (pool: Pool) =>
  (await pool.query('SELECT code, name, price_month, price_year FROM plan ORDER BY price_month')).rows as
    { code: string; name: string; price_month: string; price_year: string }[];

export async function listAudit(pool: Pool, tenantId?: string, limit = 100) {
  const r = await pool.query(
    'SELECT * FROM platform_audit WHERE ($1::uuid IS NULL OR tenant_id=$1) ORDER BY id DESC LIMIT $2', [tenantId ?? null, limit]);
  return r.rows;
}

export async function getTenantPlanFeatures(pool: Pool, tenantId: string): Promise<FeatureMap> {
  const r = await pool.query('SELECT p.features FROM tenant t JOIN plan p ON p.id=t.plan_id WHERE t.id=$1', [tenantId]);
  return r.rows[0]?.features ?? {};
}

export async function listSupportAccess(pool: Pool, tenantId: string, limit = 20) {
  const r = await pool.query('SELECT * FROM support_access WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2', [tenantId, limit]);
  return r.rows as { id: string; platform_user_email: string; reason: string; created_at: Date; expires_at: Date; ended_at: Date | null }[];
}

// ===== Extension theo cửa hàng (cổng quản trị) =====
import { createHash } from 'node:crypto';
import { checkCompatibility, getExtension, listExtensions, parseExtensionConfig, validateMigrationSql, type ExtensionDefinition } from '@rentpro/extension-sdk';
import { resolveFeatures } from '@rentpro/tenancy';

export interface TenantExtensionAdminRow {
  code: string; name: string; version: string; description: string | null; hooks: string[]; compatible: string | null;
  enabled: boolean; config: unknown; enabledAt: Date | null; enabledBy: string | null; installed: boolean;
}

/** Extension đã cài trong bản triển khai (registry) cùng trạng thái bật/tắt và cấu hình của một cửa hàng. */
export async function listTenantExtensionsAdmin(pool: Pool, tenantId: string): Promise<TenantExtensionAdminRow[]> {
  const rows = (await pool.query('SELECT * FROM tenant_extension WHERE tenant_id=$1', [tenantId])).rows;
  const byCode = new Map(rows.map((r) => [r.extension_code as string, r]));
  const out: TenantExtensionAdminRow[] = listExtensions().map((d) => {
    const r = byCode.get(d.manifest.code);
    return {
      code: d.manifest.code, name: d.manifest.name, version: d.manifest.version, description: d.manifest.description ?? null, hooks: d.manifest.hooks, compatible: checkCompatibility(d.manifest),
      enabled: r?.enabled === true, config: r?.config ?? {}, enabledAt: r?.enabled_at ?? null, enabledBy: r?.enabled_by ?? null, installed: true,
    };
  });
  // Cửa hàng còn bản ghi cho extension không còn được cài: hiện ra để quản trị gỡ
  for (const r of rows) if (!getExtension(r.extension_code)) out.push({ code: r.extension_code, name: r.extension_code, version: r.version ?? '?', description: null, hooks: [], compatible: 'Extension chưa được cài trong bản triển khai này.', enabled: r.enabled, config: r.config, enabledAt: r.enabled_at, enabledBy: r.enabled_by, installed: false });
  return out;
}

/**
 * Bật/tắt extension và đặt cấu hình cho một cửa hàng. Chỉ extension đã cài, tương thích SDK; cấu hình kiểm theo schema của extension;
 * bật cần cửa hàng có tính năng `extensions` (theo gói hoặc ghi đè).
 */
export async function setTenantExtension(pool: Pool, actor: Actor, tenantId: string, code: string, input: { enabled: boolean; config?: unknown }): Promise<void> {
  const def = getExtension(code);
  if (!def) throw new PlatformError(`Extension "${code}" chưa được cài trong bản triển khai này (chạy pnpm ext:sync và build lại).`);
  const compat = checkCompatibility(def.manifest);
  if (compat) throw new PlatformError(compat);
  const cfg = parseExtensionConfig(def, input.config ?? {});
  if (!cfg.ok) throw new PlatformError(`Cấu hình không hợp lệ: ${cfg.error}`);
  await tx(pool, async (db) => {
    const t = (await db.query('SELECT t.feature_overrides, p.features FROM tenant t JOIN plan p ON p.id=t.plan_id WHERE t.id=$1 FOR UPDATE OF t', [tenantId])).rows[0];
    if (!t) throw new PlatformError('Không tìm thấy khách hàng.');
    if (input.enabled && resolveFeatures({ planFeatures: t.features, overrides: t.feature_overrides })['extensions'] !== true) throw new PlatformError('Gói của khách hàng chưa có tính năng extension. Hãy đổi gói hoặc bật ghi đè "extensions" trước.');
    await db.query(
      `INSERT INTO tenant_extension(tenant_id, extension_code, enabled, config, version, enabled_at, enabled_by) VALUES ($1,$2,$3,$4,$5,CASE WHEN $3 THEN now() END,$6)
       ON CONFLICT (tenant_id, extension_code) DO UPDATE SET enabled=EXCLUDED.enabled, config=EXCLUDED.config, version=EXCLUDED.version,
         enabled_at = CASE WHEN EXCLUDED.enabled AND NOT tenant_extension.enabled THEN now() WHEN EXCLUDED.enabled THEN tenant_extension.enabled_at ELSE NULL END, enabled_by = EXCLUDED.enabled_by`,
      [tenantId, code, input.enabled, JSON.stringify(cfg.config), def.manifest.version, actor.email]);
    await audit(db, actor, input.enabled ? 'tenant.extension.enable' : 'tenant.extension.disable', tenantId, { code, version: def.manifest.version, config: cfg.config });
  });
}

export async function listExtensionErrors(pool: Pool, tenantId: string, limit = 30) {
  return (await pool.query('SELECT extension_code, hook, message, created_at FROM extension_error_log WHERE tenant_id=$1 ORDER BY id DESC LIMIT $2', [tenantId, Math.min(limit, 200)])).rows as { extension_code: string; hook: string; message: string; created_at: Date }[];
}

/**
 * Áp migration riêng của các extension đã cài (chạy bằng role quản trị, một lần cho mỗi migration, có checksum).
 * Chỉ nhận migration đạt `validateMigrationSql` (bảng `ext_<mã>_*` có RLS); bảng mới được cấp quyền cho rentpro_app tự động.
 */
export async function applyExtensionMigrations(pool: Pool, defs: ExtensionDefinition[] = listExtensions()): Promise<string[]> {
  const applied: string[] = [];
  for (const d of defs) {
    for (const m of d.manifest.migrations ?? []) {
      const bad = validateMigrationSql(d.manifest.code, m.sql);
      if (bad) throw new PlatformError(`Migration "${m.id}" của extension "${d.manifest.code}" không hợp lệ: ${bad}`);
      const checksum = createHash('sha256').update(m.sql).digest('hex');
      const done = (await pool.query('SELECT checksum FROM ext_migration WHERE extension_code=$1 AND migration_id=$2', [d.manifest.code, m.id])).rows[0];
      if (done) {
        if (done.checksum !== checksum) throw new PlatformError(`Migration "${m.id}" của extension "${d.manifest.code}" đã áp dụng nhưng nội dung đã bị sửa. Không sửa migration đã chạy: hãy thêm migration mới.`);
        continue;
      }
      await tx(pool, async (db) => {
        await db.query(m.sql);
        for (const t of m.sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi)) {
          await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t[1]} TO rentpro_app`);
          await db.query(`GRANT ALL ON ${t[1]} TO rentpro_admin`);
        }
        await db.query('INSERT INTO ext_migration(extension_code, migration_id, checksum) VALUES ($1,$2,$3)', [d.manifest.code, m.id, checksum]);
      });
      applied.push(`${d.manifest.code}:${m.id}`);
    }
  }
  return applied;
}

export { tx as platformTx, audit as platformAudit };
