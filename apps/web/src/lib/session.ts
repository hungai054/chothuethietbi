import { redirect } from 'next/navigation';
import { IMPERSONATION_PERMISSIONS, type Permission } from '@rentpro/core';
import { loadUserAccess, withTenantId } from '@rentpro/db';
import { auth } from '@/auth';
import { pool } from './db';
import { getTenant, type TenantInfo } from './tenant';

export interface SupportInfo { by: string; expiresAt: Date }
export interface AppSession {
  tenant: TenantInfo;
  user: { id: string; name: string; role: string };
  permissions: ReadonlySet<Permission>;
  support: SupportInfo | null;
}

/** Phiên hợp lệ cho tenant của request này, hoặc null. Phiên hỗ trợ được kiểm tra lại trong DB mỗi lần. */
export async function getAppSession(): Promise<AppSession | null> {
  const tenant = await getTenant();
  const session = await auth();
  if (!tenant || !session || session.user.tenantId !== tenant.id) return null;
  const sid = session.user.supportAccessId;
  if (sid) {
    const row = await withTenantId(pool(), tenant.id, async (db) =>
      (await db.query('SELECT platform_user_email, expires_at FROM support_access WHERE id=$1 AND ended_at IS NULL AND expires_at > now()', [sid])).rows[0],
    );
    if (!row) return null;
    return {
      tenant,
      user: { id: session.user.id, name: session.user.name ?? 'Hỗ trợ', role: session.user.role },
      permissions: new Set(IMPERSONATION_PERMISSIONS),
      support: { by: row.platform_user_email, expiresAt: row.expires_at },
    };
  }
  // Quyền đọc lại từ DB mỗi request: khóa tài khoản hoặc đổi vai trò có hiệu lực ngay, không đợi phiên (JWT) hết hạn
  const access = await withTenantId(pool(), tenant.id, (db) => loadUserAccess(db, session.user.id, tenant.features));
  if (!access || !access.active) return null;
  return {
    tenant,
    user: { id: session.user.id, name: session.user.name ?? '', role: access.role },
    permissions: access.permissions,
    support: null,
  };
}

export async function requireAppSession(): Promise<AppSession> {
  const s = await getAppSession();
  if (!s) redirect('/login');
  return s;
}

/** Chỉ cần quyền (không gắn với tính năng của gói), VD trang Gói dịch vụ phải vào được ở mọi gói. */
export async function requirePermission(perm: Permission): Promise<AppSession> {
  const s = await requireAppSession();
  if (!s.permissions.has(perm)) redirect('/?error=' + encodeURIComponent('Bạn không có quyền truy cập mục này.'));
  return s;
}

/** Chặn truy cập trang khi thiếu tính năng của gói hoặc thiếu quyền; người dùng được đưa về trang chủ với thông báo rõ ràng. */
export async function requireAccess(feature: keyof AppSession['tenant']['features'], perm: Permission): Promise<AppSession> {
  const s = await requireAppSession();
  if (!s.tenant.features[feature]) redirect('/?error=' + encodeURIComponent('Gói hiện tại chưa có tính năng này.'));
  if (!s.permissions.has(perm)) redirect('/?error=' + encodeURIComponent('Bạn không có quyền truy cập mục này.'));
  return s;
}
