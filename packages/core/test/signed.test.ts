import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, validateImpersonationRequest, IMPERSONATION_PERMISSIONS } from '../src';

const S = 'a-secret-at-least-16-chars';

describe('token ký', () => {
  const now = 1_700_000_000_000;
  it('ký và xác thực', () => {
    const t = signToken({ sid: 'abc' }, S, 60, now);
    expect(verifyToken<{ sid: string }>(t, S, now + 1000)?.sid).toBe('abc');
  });
  it('hết hạn thì từ chối', () => {
    const t = signToken({ sid: 'abc' }, S, 60, now);
    expect(verifyToken(t, S, now + 61_000)).toBeNull();
  });
  it('sai khóa, sửa payload, sai định dạng đều bị từ chối', () => {
    const t = signToken({ sid: 'abc', admin: false }, S, 60, now);
    expect(verifyToken(t, 'another-secret-16chars', now)).toBeNull();
    const [, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sid: 'abc', admin: true, exp: 9e9 })).toString('base64url') + '.' + sig;
    expect(verifyToken(forged, S, now)).toBeNull();
    expect(verifyToken('rac', S, now)).toBeNull();
    expect(verifyToken(t + '.x', S, now)).toBeNull();
  });
  it('khóa quá ngắn bị từ chối khi ký', () => {
    expect(() => signToken({}, 'short', 60)).toThrow();
  });
});

describe('đăng nhập thay', () => {
  it('kiểm tra lý do và thời hạn', () => {
    expect(validateImpersonationRequest('xx', 30)).not.toBeNull();
    expect(validateImpersonationRequest('khách báo lỗi', 4)).not.toBeNull();
    expect(validateImpersonationRequest('khách báo lỗi', 121)).not.toBeNull();
    expect(validateImpersonationRequest('khách báo lỗi', 30)).toBeNull();
  });
  it('phiên hỗ trợ không xem giấy tờ tùy thân và không đụng thuê bao/xóa dữ liệu', () => {
    for (const p of ['customer.id_document.view', 'billing.manage', 'data.delete', 'data.export'] as const)
      expect(IMPERSONATION_PERMISSIONS).not.toContain(p);
    expect(IMPERSONATION_PERMISSIONS).toContain('booking.create');
  });
});
