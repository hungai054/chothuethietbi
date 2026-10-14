import { PERMISSIONS, type Permission } from '../auth/permissions';

// ===== Vai trò tùy chỉnh =====

/** Quyền chỉ chủ cửa hàng có: không gán được cho vai trò tùy chỉnh (tránh tự nâng quyền và mất kiểm soát thanh toán/xóa dữ liệu). */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] = ['billing.manage', 'roles.manage', 'data.delete'];

export const PERMISSION_LABEL: Record<Permission, string> = {
  'inventory.view': 'Xem thiết bị', 'inventory.manage': 'Quản lý thiết bị', 'inventory.stocktake': 'Kiểm kê',
  'customer.view': 'Xem khách hàng', 'customer.manage': 'Quản lý khách hàng', 'customer.id_document.view': 'Xem giấy tờ tùy thân', 'customer.anonymize': 'Ẩn danh khách hàng',
  'booking.view': 'Xem đơn thuê', 'booking.create': 'Tạo / sửa đơn', 'booking.cancel': 'Hủy đơn', 'booking.handover': 'Giao / nhận thiết bị',
  'contract.view': 'Xem hợp đồng', 'contract.create': 'Lập hợp đồng', 'contract.sign': 'Ký hợp đồng',
  'payment.view': 'Xem thanh toán', 'payment.create': 'Ghi thu tiền',
  'deposit.view': 'Xem tiền cọc', 'deposit.collect': 'Thu cọc / nhận tài sản', 'deposit.refund': 'Hoàn cọc / xóa nợ / hủy khoản',
  'pricing.view': 'Xem bảng giá', 'pricing.manage': 'Sửa bảng giá',
  'maintenance.view': 'Xem bảo trì', 'maintenance.manage': 'Quản lý bảo trì',
  'reports.view': 'Xem báo cáo cơ bản', 'reports.finance': 'Xem báo cáo tiền',
  'settings.manage': 'Cài đặt cửa hàng', 'users.manage': 'Quản lý người dùng', 'roles.manage': 'Quản lý vai trò',
  'billing.manage': 'Thanh toán gói', 'data.export': 'Xuất dữ liệu', 'data.delete': 'Xóa dữ liệu', 'audit.view': 'Xem nhật ký',
  'notification.view': 'Xem tin nhắn', 'notification.manage': 'Quản lý tin nhắn',
};

/** Nhóm quyền hiển thị trong ma trận */
export const PERMISSION_GROUPS: { title: string; perms: Permission[] }[] = [
  { title: 'Thiết bị', perms: ['inventory.view', 'inventory.manage', 'inventory.stocktake'] },
  { title: 'Khách hàng', perms: ['customer.view', 'customer.manage', 'customer.id_document.view', 'customer.anonymize'] },
  { title: 'Đơn thuê', perms: ['booking.view', 'booking.create', 'booking.cancel', 'booking.handover'] },
  { title: 'Hợp đồng', perms: ['contract.view', 'contract.create', 'contract.sign'] },
  { title: 'Thanh toán và cọc', perms: ['payment.view', 'payment.create', 'deposit.view', 'deposit.collect', 'deposit.refund'] },
  { title: 'Bảng giá', perms: ['pricing.view', 'pricing.manage'] },
  { title: 'Bảo trì', perms: ['maintenance.view', 'maintenance.manage'] },
  { title: 'Báo cáo và tin nhắn', perms: ['reports.view', 'reports.finance', 'notification.view', 'notification.manage'] },
  { title: 'Quản trị', perms: ['settings.manage', 'users.manage', 'data.export', 'audit.view'] },
];

/** Quyền ghi kéo theo quyền xem (có quyền sửa mà không xem được thì giao diện hỏng). */
const IMPLIES: Partial<Record<Permission, Permission>> = {
  'inventory.manage': 'inventory.view', 'inventory.stocktake': 'inventory.view',
  'customer.manage': 'customer.view', 'customer.id_document.view': 'customer.view', 'customer.anonymize': 'customer.manage',
  'booking.create': 'booking.view', 'booking.cancel': 'booking.view', 'booking.handover': 'booking.view',
  'contract.create': 'contract.view', 'contract.sign': 'contract.view',
  'payment.create': 'payment.view', 'deposit.collect': 'deposit.view', 'deposit.refund': 'deposit.view',
  'pricing.manage': 'pricing.view', 'maintenance.manage': 'maintenance.view', 'reports.finance': 'reports.view', 'notification.manage': 'notification.view',
};

export interface RoleInput { name: string; permissions: string[] }
export interface NormalizedRole { name: string; permissions: Permission[]; added: Permission[] }

export class RoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleError';
  }
}

/** Kiểm tra và chuẩn hóa vai trò tùy chỉnh. Tự thêm quyền xem còn thiếu (và trả danh sách đã thêm để báo người dùng). */
export function normalizeRole(i: RoleInput): NormalizedRole {
  const name = i.name.trim();
  if (name.length < 2 || name.length > 40) throw new RoleError('Tên vai trò phải từ 2 đến 40 ký tự.');
  if (/[<>]/.test(name)) throw new RoleError('Tên vai trò không được chứa ký tự < hoặc >.');
  const known = new Set<string>(PERMISSIONS);
  for (const p of i.permissions) {
    if (!known.has(p)) throw new RoleError(`Quyền "${p}" không tồn tại.`);
    if ((OWNER_ONLY_PERMISSIONS as readonly string[]).includes(p)) throw new RoleError(`Quyền "${PERMISSION_LABEL[p as Permission]}" chỉ dành cho chủ cửa hàng, không gán cho vai trò tùy chỉnh được.`);
  }
  const set = new Set(i.permissions as Permission[]);
  const added: Permission[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const p of [...set]) {
      const need = IMPLIES[p];
      if (need && !set.has(need)) { set.add(need); added.push(need); changed = true; }
    }
  }
  if (set.size === 0) throw new RoleError('Vai trò cần ít nhất một quyền.');
  return { name, permissions: PERMISSIONS.filter((p) => set.has(p)), added };
}

/** Khi đọc quyền từ DB: bỏ quyền không còn tồn tại hoặc dành riêng cho chủ (phòng dữ liệu bị sửa tay). */
export function sanitizeCustomPermissions(perms: readonly string[]): Permission[] {
  const known = new Set<string>(PERMISSIONS);
  return perms.filter((p): p is Permission => known.has(p) && !(OWNER_ONLY_PERMISSIONS as readonly string[]).includes(p));
}
