import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, suggestSlug, validateSignup, validateSlug } from '../src';

const ok = { email: 'chu@cuahang.vn', ownerName: 'Nguyễn Văn An', shopName: 'Cho Thuê Máy Ảnh An', slug: 'may-anh-an', password: 'Mat-khau-1234' };

describe('đăng ký', () => {
  it('gợi ý slug bỏ dấu tiếng Việt', () => {
    expect(suggestSlug('Cho Thuê Máy Ảnh Đà Nẵng')).toBe('cho-thue-may-anh-da-nang');
    expect(suggestSlug('  --Studio  Ánh Sáng!! ')).toBe('studio-anh-sang');
    expect(suggestSlug('???')).toBe('');
    expect(suggestSlug('a'.repeat(60)).length).toBeLessThanOrEqual(30);
  });
  it('slug hợp lệ và bị từ chối', () => {
    expect(validateSlug('may-anh-an')).toBeNull();
    expect(validateSlug('a')).toMatch(/2–41/);
    expect(validateSlug('Chu-Hoa')).toMatch(/chữ thường/);
    expect(validateSlug('-abc')).toMatch(/chữ thường/);
    expect(validateSlug('abc-')).toMatch(/gạch ngang/);
    expect(validateSlug('a--b')).toMatch(/gạch ngang/);
    for (const r of ['www', 'admin', 'api', 'demo']) { expect(RESERVED_SLUGS.has(r)).toBe(true); expect(validateSlug(r)).toMatch(/giữ riêng/); }
  });
  it('đầu vào hợp lệ → null; từng lỗi có thông báo tiếng Việt', () => {
    expect(validateSignup(ok)).toBeNull();
    expect(validateSignup({ ...ok, email: 'khong-phai-email' })).toMatch(/Email/);
    expect(validateSignup({ ...ok, ownerName: ' ' })).toMatch(/họ tên/);
    expect(validateSignup({ ...ok, shopName: 'a' })).toMatch(/Tên cửa hàng/);
    expect(validateSignup({ ...ok, slug: 'admin' })).toMatch(/giữ riêng/);
    expect(validateSignup({ ...ok, password: 'ngan1' })).toMatch(/10 ký tự/);
    expect(validateSignup({ ...ok, password: 'toàn-chữ-không-số' })).toMatch(/chữ và số/);
  });
});
