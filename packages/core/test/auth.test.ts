import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS, permissionsFor, requirePermission, ForbiddenError, canAccessBranch, platformCan,
  hashPassword, verifyPassword, validatePasswordStrength,
  base32Encode, base32Decode, totpAt, verifyTotp, generateTotpSecret, type Actor,
} from '../src';

const actor = (role: 'OWNER' | 'MANAGER' | 'STAFF' | 'TECHNICIAN', branchIds: string[] = []): Actor => ({
  userId: 'u', tenantId: 't', permissions: permissionsFor(role), branchIds,
});

describe('phân quyền cửa hàng', () => {
  it('kỹ thuật viên không xem được tiền và giấy tờ tùy thân', () => {
    const t = actor('TECHNICIAN');
    for (const p of ['payment.view', 'deposit.view', 'customer.id_document.view', 'reports.finance'] as const)
      expect(() => requirePermission(t, p)).toThrow(ForbiddenError);
    expect(() => requirePermission(t, 'maintenance.manage')).not.toThrow();
  });
  it('nhân viên quầy không xem giấy tờ tùy thân, không hoàn cọc', () => {
    const s = actor('STAFF');
    expect(() => requirePermission(s, 'customer.id_document.view')).toThrow();
    expect(() => requirePermission(s, 'deposit.refund')).toThrow();
    expect(() => requirePermission(s, 'booking.create')).not.toThrow();
  });
  it('quản lý xem được giấy tờ, nhưng không xóa/xuất dữ liệu hay thanh toán thuê bao', () => {
    const m = actor('MANAGER');
    expect(() => requirePermission(m, 'customer.id_document.view')).not.toThrow();
    for (const p of ['data.delete', 'data.export', 'billing.manage'] as const) expect(() => requirePermission(m, p)).toThrow();
  });
  it('chủ cửa hàng có toàn quyền', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.OWNER.length).toBeGreaterThan(DEFAULT_ROLE_PERMISSIONS.MANAGER.length);
  });
  it('vai trò tùy chỉnh thay thế mặc định', () => {
    const a = { ...actor('STAFF'), permissions: permissionsFor('STAFF', ['booking.view']) };
    expect(() => requirePermission(a, 'booking.create')).toThrow();
  });
  it('giới hạn theo chi nhánh', () => {
    expect(canAccessBranch(actor('STAFF', ['b1']), 'b1')).toBe(true);
    expect(canAccessBranch(actor('STAFF', ['b1']), 'b2')).toBe(false);
    expect(canAccessBranch(actor('STAFF'), 'b2')).toBe(true);
  });
});

describe('phân quyền nền tảng', () => {
  it('SUPPORT không đổi gói, không xóa tenant; SALES không đăng nhập thay', () => {
    expect(platformCan('SUPPORT', 'tenant.impersonate')).toBe(true);
    expect(platformCan('SUPPORT', 'tenant.change_plan')).toBe(false);
    expect(platformCan('SUPPORT', 'tenant.delete')).toBe(false);
    expect(platformCan('SALES', 'tenant.create')).toBe(true);
    expect(platformCan('SALES', 'tenant.impersonate')).toBe(false);
    expect(platformCan('SUPER_ADMIN', 'tenant.delete')).toBe(true);
  });
});

describe('mật khẩu', () => {
  it('băm argon2id và xác thực', async () => {
    const h = await hashPassword('Mat-khau-1234');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(h, 'Mat-khau-1234')).toBe(true);
    expect(await verifyPassword(h, 'sai')).toBe(false);
    expect(await verifyPassword('rac', 'x')).toBe(false);
  });
  it('kiểm tra độ mạnh', () => {
    expect(validatePasswordStrength('ngan1')).not.toBeNull();
    expect(validatePasswordStrength('toanchucaiaaaa')).not.toBeNull();
    expect(validatePasswordStrength('Matkhau12345')).toBeNull();
  });
});

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890')); // khóa kiểm thử của RFC
  it('khớp vector chuẩn RFC 6238 (SHA1, 8 chữ số)', () => {
    expect(totpAt(secret, 59_000, 8)).toBe('94287082');
    expect(totpAt(secret, 1111111109_000, 8)).toBe('07081804');
    expect(totpAt(secret, 2000000000_000, 8)).toBe('69279037');
  });
  it('base32 qua lại', () => {
    const b = Buffer.from('xin chao');
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });
  it('xác thực với cửa sổ ±1 và chống dùng lại', () => {
    const s = generateTotpSecret();
    const now = 1_700_000_000_000;
    const code = totpAt(s, now);
    const step = verifyTotp(s, code, now);
    expect(step).not.toBeNull();
    expect(verifyTotp(s, code, now + 30_000)).not.toBeNull();
    expect(verifyTotp(s, code, now + 90_000)).toBeNull();
    expect(verifyTotp(s, code, now, 1, step!)).toBeNull();
    expect(verifyTotp(s, '12ab56', now)).toBeNull();
  });
});
