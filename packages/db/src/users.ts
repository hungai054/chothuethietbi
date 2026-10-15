import {
  DEFAULT_ROLE_PERMISSIONS, ForbiddenError, RoleError, TENANT_ROLES, hashPassword, normalizeRole, permissionsFor, sanitizeCustomPermissions, validatePasswordStrength, verifyPassword,
  type Permission, type TenantRole,
} from '@rentpro/core';
import { assertWithinLimit, can, type ResolvedFeatures } from '@rentpro/tenancy';
import type { Db } from './client';
import { NotFoundError, ReadOnlyError, ValidationError, audit, guard, type ServiceCtx } from './service';

type Row = Record<string, any>;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Quản lý người dùng là chức năng nền (mọi gói): chỉ kiểm quyền và chế độ chỉ đọc. */
function need(ctx: ServiceCtx, perm: Permission, write: boolean) {
  if (!ctx.permissions.has(perm)) throw new ForbiddenError(perm);
  if (write && (ctx.tenantStatus === 'READ_ONLY' || ctx.tenantStatus === 'SUSPENDED')) throw new ReadOnlyError();
}
const isOwnerActor = (ctx: ServiceCtx) => ctx.permissions.has('roles.manage'); // quyền chỉ chủ cửa hàng có

// ===== Quyền hiệu lực của người dùng (dùng khi dựng phiên đăng nhập) =====
export interface UserAccess { active: boolean; role: TenantRole; customRoleId: string | null; permissions: ReadonlySet<Permission>; mustChangePassword: boolean }

/**
 * Quyền hiệu lực: vai trò tùy chỉnh thay thế quyền mặc định của vai trò nền — chỉ khi gói còn tính năng `custom_roles`
 * (hạ gói thì tự về quyền mặc định, không giữ quyền cao ngoài ý muốn). Người dùng bị khóa không còn quyền gì.
 */
export async function loadUserAccess(db: Db, userId: string, features: ResolvedFeatures): Promise<UserAccess | null> {
  const r = (await db.query(
    `SELECT u.active, u.role, u.custom_role_id, u.must_change_password, cr.permissions FROM app_user u LEFT JOIN custom_role cr ON cr.id = u.custom_role_id WHERE u.id=$1`, [userId])).rows[0];
  if (!r) return null;
  const custom = r.permissions && features['custom_roles'] === true ? sanitizeCustomPermissions(r.permissions) : undefined;
  return { active: r.active, role: r.role, customRoleId: r.custom_role_id, permissions: r.active ? permissionsFor(r.role, custom) : new Set(), mustChangePassword: r.must_change_password === true };
}

// ===== Vai trò tùy chỉnh =====
export interface CustomRoleRow { id: string; name: string; permissions: Permission[]; users: number }

export async function listCustomRoles(ctx: ServiceCtx): Promise<CustomRoleRow[]> {
  if (!ctx.permissions.has('users.manage') && !ctx.permissions.has('roles.manage')) throw new ForbiddenError('users.manage');
  const rows = (await ctx.db.query(
    `SELECT r.id, r.name, r.permissions, (SELECT count(*)::int FROM app_user u WHERE u.custom_role_id=r.id) AS users FROM custom_role r ORDER BY lower(r.name)`)).rows;
  return rows.map((r: Row) => ({ id: r.id, name: r.name, permissions: sanitizeCustomPermissions(r.permissions), users: r.users }));
}

function roleInput(name: string, permissions: string[]) {
  try { return normalizeRole({ name, permissions }); } catch (e) { if (e instanceof RoleError) throw new ValidationError(e.message); throw e; }
}

export async function createCustomRole(ctx: ServiceCtx, name: string, permissions: string[]): Promise<{ id: string; added: Permission[] }> {
  need(ctx, 'roles.manage', true);
  guard(ctx, 'roles.manage', 'custom_roles', { write: true });
  const n = roleInput(name, permissions);
  try {
    const r = await ctx.db.query('INSERT INTO custom_role(tenant_id,name,permissions) VALUES ($1,$2,$3) RETURNING id', [ctx.tenantId, n.name, n.permissions]);
    await audit(ctx, 'role.create', 'custom_role', r.rows[0].id, { name: n.name, permissions: n.permissions });
    return { id: r.rows[0].id, added: n.added };
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ValidationError(`Đã có vai trò tên "${n.name}".`);
    throw e;
  }
}

export async function updateCustomRole(ctx: ServiceCtx, id: string, name: string, permissions: string[]): Promise<{ added: Permission[] }> {
  need(ctx, 'roles.manage', true);
  guard(ctx, 'roles.manage', 'custom_roles', { write: true });
  const n = roleInput(name, permissions);
  try {
    const r = await ctx.db.query('UPDATE custom_role SET name=$2, permissions=$3 WHERE id=$1', [id, n.name, n.permissions]);
    if (!r.rowCount) throw new NotFoundError('vai trò');
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ValidationError(`Đã có vai trò tên "${n.name}".`);
    throw e;
  }
  await audit(ctx, 'role.update', 'custom_role', id, { name: n.name, permissions: n.permissions });
  return { added: n.added };
}

export async function deleteCustomRole(ctx: ServiceCtx, id: string): Promise<void> {
  need(ctx, 'roles.manage', true);
  const used = (await ctx.db.query('SELECT count(*)::int n FROM app_user WHERE custom_role_id=$1', [id])).rows[0].n;
  if (used > 0) throw new ValidationError(`Còn ${used} người dùng đang giữ vai trò này. Hãy chuyển họ sang vai trò khác trước.`);
  const r = await ctx.db.query('DELETE FROM custom_role WHERE id=$1', [id]);
  if (!r.rowCount) throw new NotFoundError('vai trò');
  await audit(ctx, 'role.delete', 'custom_role', id);
}

// ===== Người dùng =====
export interface UserRow { id: string; email: string; name: string; role: TenantRole; customRoleId: string | null; customRoleName: string | null; active: boolean; createdAt: Date }

export async function listUsers(ctx: ServiceCtx): Promise<UserRow[]> {
  need(ctx, 'users.manage', false);
  const rows = (await ctx.db.query(
    `SELECT u.id, u.email, u.name, u.role, u.custom_role_id, cr.name AS custom_role_name, u.active, u.created_at FROM app_user u LEFT JOIN custom_role cr ON cr.id=u.custom_role_id ORDER BY u.active DESC, u.created_at`)).rows;
  return rows.map((u: Row) => ({ id: u.id, email: u.email, name: u.name, role: u.role, customRoleId: u.custom_role_id, customRoleName: u.custom_role_name, active: u.active, createdAt: u.created_at }));
}

async function activeCount(ctx: ServiceCtx): Promise<number> {
  return (await ctx.db.query('SELECT count(*)::int n FROM app_user WHERE active')).rows[0].n;
}

async function checkRoleChoice(ctx: ServiceCtx, role: string, customRoleId: string | null | undefined): Promise<void> {
  if (!(TENANT_ROLES as readonly string[]).includes(role)) throw new ValidationError('Vai trò không hợp lệ.');
  if (role === 'OWNER' && !isOwnerActor(ctx)) throw new ForbiddenError('roles.manage');
  if (customRoleId) {
    if (!can(ctx.features, 'custom_roles')) throw new ValidationError('Gói hiện tại không có vai trò tùy chỉnh. Hãy nâng cấp gói.');
    if (role === 'OWNER') throw new ValidationError('Chủ cửa hàng luôn có đủ quyền, không gắn vai trò tùy chỉnh.');
    if (!(await ctx.db.query('SELECT 1 FROM custom_role WHERE id=$1', [customRoleId])).rowCount) throw new NotFoundError('vai trò');
  }
}

export interface UserInput { email: string; name: string; password: string; role: TenantRole; customRoleId?: string | null }

export async function createUser(ctx: ServiceCtx, i: UserInput): Promise<string> {
  need(ctx, 'users.manage', true);
  const email = i.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) throw new ValidationError('Email không hợp lệ.');
  const name = i.name.trim();
  if (name.length < 2 || name.length > 80) throw new ValidationError('Họ tên phải từ 2 đến 80 ký tự.');
  const weak = validatePasswordStrength(i.password);
  if (weak) throw new ValidationError(weak);
  await checkRoleChoice(ctx, i.role, i.customRoleId);
  assertWithinLimit(ctx.limits, 'users', await activeCount(ctx));
  try {
    const r = await ctx.db.query('INSERT INTO app_user(tenant_id,email,name,password_hash,role,custom_role_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [ctx.tenantId, email, name, await hashPassword(i.password), i.role, i.customRoleId ?? null]);
    await audit(ctx, 'user.create', 'app_user', r.rows[0].id, { email, role: i.role, customRoleId: i.customRoleId ?? null });
    return r.rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ValidationError('Email này đã có tài khoản trong cửa hàng.');
    throw e;
  }
}

export interface UserPatch { name?: string; role?: TenantRole; customRoleId?: string | null; active?: boolean }

export async function updateUser(ctx: ServiceCtx, id: string, p: UserPatch): Promise<void> {
  need(ctx, 'users.manage', true);
  const u = (await ctx.db.query('SELECT * FROM app_user WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!u) throw new NotFoundError('người dùng');
  if (u.role === 'OWNER' && !isOwnerActor(ctx)) throw new ForbiddenError('roles.manage'); // quản lý không sửa được chủ cửa hàng
  const name = p.name === undefined ? u.name : p.name.trim();
  if (name.length < 2 || name.length > 80) throw new ValidationError('Họ tên phải từ 2 đến 80 ký tự.');
  const role = p.role ?? u.role;
  const customRoleId = p.customRoleId === undefined ? (p.role && p.role !== u.role ? null : u.custom_role_id) : p.customRoleId;
  const active = p.active ?? u.active;
  if (p.role !== undefined || p.customRoleId !== undefined) await checkRoleChoice(ctx, role, customRoleId);
  if (ctx.userId && id === ctx.userId && !active) throw new ValidationError('Bạn không thể tự khóa tài khoản của mình.');
  if (ctx.userId && id === ctx.userId && role !== u.role) throw new ValidationError('Bạn không thể tự đổi vai trò của mình.');
  if (u.role === 'OWNER' && (role !== 'OWNER' || !active)) {
    const owners = (await ctx.db.query(`SELECT count(*)::int n FROM app_user WHERE role='OWNER' AND active AND id <> $1`, [id])).rows[0].n;
    if (owners === 0) throw new ValidationError('Cửa hàng phải còn ít nhất một chủ cửa hàng đang hoạt động.');
  }
  if (active && !u.active) assertWithinLimit(ctx.limits, 'users', await activeCount(ctx));
  await ctx.db.query('UPDATE app_user SET name=$2, role=$3, custom_role_id=$4, active=$5 WHERE id=$1', [id, name, role, customRoleId, active]);
  await audit(ctx, 'user.update', 'app_user', id, { role, customRoleId, active, was: { role: u.role, customRoleId: u.custom_role_id, active: u.active } });
}

export async function setUserPassword(ctx: ServiceCtx, id: string, password: string): Promise<void> {
  need(ctx, 'users.manage', true);
  const weak = validatePasswordStrength(password);
  if (weak) throw new ValidationError(weak);
  const u = (await ctx.db.query('SELECT role FROM app_user WHERE id=$1', [id])).rows[0];
  if (!u) throw new NotFoundError('người dùng');
  if (u.role === 'OWNER' && !isOwnerActor(ctx) ) throw new ForbiddenError('roles.manage');
  // Đặt hộ người khác: họ phải tự đổi ở lần đăng nhập tới (người quản lý đã biết mật khẩu này). Tự đặt cho mình thì không cần.
  const forced = id !== ctx.userId;
  await ctx.db.query('UPDATE app_user SET password_hash=$2, must_change_password=$3 WHERE id=$1', [id, await hashPassword(password), forced]);
  await audit(ctx, 'user.password', 'app_user', id, { forceChange: forced });
}

// Chặn dò mật khẩu hiện tại từ một phiên bị lộ: 5 lần sai / 15 phút / người dùng (trong bộ nhớ của tiến trình; nhiều bản chạy song song thì mỗi bản đếm riêng)
const wrongCurrent = new Map<string, number[]>();
const WRONG_MAX = 5;
const WRONG_WINDOW_MS = 15 * 60_000;

/**
 * Người dùng tự đổi mật khẩu của mình. Không cần quyền riêng (ai đăng nhập cũng được) và vẫn đổi được khi cửa hàng ở chế độ chỉ đọc,
 * vì đây là việc bảo mật của chính họ. Phải nhập đúng mật khẩu hiện tại; mật khẩu mới phải mạnh và khác mật khẩu hiện tại. Tắt cờ buộc đổi.
 */
export async function changeOwnPassword(ctx: ServiceCtx, current: string, next: string): Promise<void> {
  if (!ctx.userId) throw new ValidationError('Phiên hỗ trợ không có tài khoản riêng để đổi mật khẩu.');
  const now = Date.now();
  const recent = (wrongCurrent.get(ctx.userId) ?? []).filter((t) => now - t < WRONG_WINDOW_MS);
  if (recent.length >= WRONG_MAX) throw new ValidationError('Nhập sai mật khẩu hiện tại quá nhiều lần. Hãy thử lại sau 15 phút.');
  const u = (await ctx.db.query('SELECT password_hash FROM app_user WHERE id=$1 AND active', [ctx.userId])).rows[0];
  if (!u) throw new NotFoundError('người dùng');
  if (!(await verifyPassword(u.password_hash, current))) {
    recent.push(now);
    wrongCurrent.set(ctx.userId, recent);
    throw new ValidationError('Mật khẩu hiện tại không đúng.');
  }
  const weak = validatePasswordStrength(next);
  if (weak) throw new ValidationError(weak);
  if (current === next) throw new ValidationError('Mật khẩu mới phải khác mật khẩu hiện tại.');
  await ctx.db.query('UPDATE app_user SET password_hash=$2, must_change_password=false WHERE id=$1', [ctx.userId, await hashPassword(next)]);
  wrongCurrent.delete(ctx.userId);
  await audit(ctx, 'user.password_change', 'app_user', ctx.userId);
}

export { DEFAULT_ROLE_PERMISSIONS };
