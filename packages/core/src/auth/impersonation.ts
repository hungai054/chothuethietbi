import { DEFAULT_ROLE_PERMISSIONS, type Permission } from './permissions';

export const MAX_IMPERSONATION_MINUTES = 120;
export const MIN_REASON_LENGTH = 5;

/** Quyền trong phiên hỗ trợ: như quản lý, nhưng không xem giấy tờ tùy thân và không đụng tới thuê bao/xóa dữ liệu. */
export const IMPERSONATION_PERMISSIONS: readonly Permission[] = DEFAULT_ROLE_PERMISSIONS.MANAGER.filter(
  (p) => p !== 'customer.id_document.view' && p !== 'customer.anonymize',
);

export function validateImpersonationRequest(reason: string, minutes: number): string | null {
  if (reason.trim().length < MIN_REASON_LENGTH) return `Lý do phải có ít nhất ${MIN_REASON_LENGTH} ký tự.`;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > MAX_IMPERSONATION_MINUTES)
    return `Thời hạn phải từ 5 đến ${MAX_IMPERSONATION_MINUTES} phút.`;
  return null;
}
