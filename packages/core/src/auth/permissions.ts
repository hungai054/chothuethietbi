/** Quyền dạng chuỗi `nhóm.hành_động`. Vai trò = tập quyền. Kiểm tra ở server. */
export const PERMISSIONS = [
  'inventory.view', 'inventory.manage', 'inventory.stocktake',
  'customer.view', 'customer.manage', 'customer.id_document.view', 'customer.anonymize',
  'booking.view', 'booking.create', 'booking.cancel', 'booking.handover',
  'contract.view', 'contract.create', 'contract.sign',
  'payment.view', 'payment.create',
  'deposit.view', 'deposit.collect', 'deposit.refund',
  'pricing.view', 'pricing.manage',
  'maintenance.view', 'maintenance.manage',
  'reports.view', 'reports.finance',
  'settings.manage', 'users.manage', 'roles.manage',
  'billing.manage', 'data.export', 'data.delete', 'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const TENANT_ROLES = ['OWNER', 'MANAGER', 'STAFF', 'TECHNICIAN'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

const FINANCE_AND_ID: Permission[] = [
  'payment.view', 'payment.create', 'deposit.view', 'deposit.collect', 'deposit.refund', 'reports.finance',
  'customer.id_document.view',
];

const MANAGER: Permission[] = PERMISSIONS.filter(
  (p) => !['billing.manage', 'data.export', 'data.delete', 'roles.manage'].includes(p),
);

export const DEFAULT_ROLE_PERMISSIONS: Record<TenantRole, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  MANAGER: MANAGER,
  STAFF: [
    'inventory.view', 'customer.view', 'customer.manage', 'booking.view', 'booking.create', 'booking.cancel',
    'booking.handover', 'contract.view', 'contract.create', 'contract.sign', 'payment.view', 'payment.create',
    'deposit.view', 'deposit.collect', 'pricing.view', 'maintenance.view', 'reports.view',
  ],
  // Kỹ thuật: không thấy tiền và giấy tờ tùy thân
  TECHNICIAN: ['inventory.view', 'inventory.manage', 'inventory.stocktake', 'booking.view', 'maintenance.view', 'maintenance.manage'],
};

// Bảo đảm bất biến nghiệp vụ: kỹ thuật viên không bao giờ có quyền tiền / giấy tờ.
for (const p of FINANCE_AND_ID) {
  if ((DEFAULT_ROLE_PERMISSIONS.TECHNICIAN as readonly string[]).includes(p)) throw new Error(`TECHNICIAN không được có ${p}`);
}

export interface Actor {
  userId: string;
  tenantId: string;
  permissions: ReadonlySet<Permission>;
  /** rỗng = mọi chi nhánh */
  branchIds: readonly string[];
}

export class ForbiddenError extends Error {
  constructor(public readonly permission: Permission) {
    super('Bạn không có quyền thực hiện thao tác này.');
    this.name = 'ForbiddenError';
  }
}

/** customRolePerms: quyền của vai trò tùy chỉnh (gói cao); nếu có thì thay thế mặc định. */
export function permissionsFor(role: TenantRole, customRolePerms?: readonly Permission[]): ReadonlySet<Permission> {
  return new Set(customRolePerms ?? DEFAULT_ROLE_PERMISSIONS[role]);
}

export const hasPermission = (a: Actor, p: Permission) => a.permissions.has(p);

export function requirePermission(a: Actor, p: Permission): void {
  if (!hasPermission(a, p)) throw new ForbiddenError(p);
}

export function canAccessBranch(a: Actor, branchId: string | null | undefined): boolean {
  if (a.branchIds.length === 0 || !branchId) return true;
  return a.branchIds.includes(branchId);
}

// ===== Cấp nền tảng =====
export const PLATFORM_ROLES = ['SUPER_ADMIN', 'SUPPORT', 'SALES'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_PERMISSIONS = [
  'tenant.view', 'tenant.create', 'tenant.change_plan', 'tenant.override_features', 'tenant.suspend',
  'tenant.impersonate', 'tenant.export', 'tenant.delete', 'plan.manage', 'coupon.manage',
  'billing.view', 'billing.confirm', 'announcement.send', 'metrics.view', 'health.view', 'extension.manage',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  SUPER_ADMIN: PLATFORM_PERMISSIONS,
  SUPPORT: ['tenant.view', 'tenant.impersonate', 'billing.view', 'health.view', 'metrics.view'],
  SALES: ['tenant.view', 'tenant.create', 'tenant.change_plan', 'billing.view', 'metrics.view'],
};

export function platformCan(role: PlatformRole, p: PlatformPermission): boolean {
  return PLATFORM_ROLE_PERMISSIONS[role].includes(p);
}
