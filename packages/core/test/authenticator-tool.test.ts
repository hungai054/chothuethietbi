import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { base32Encode, generateTotpSecret, totpAt } from '../src';

// Công cụ lấy mã độc lập (tools/authenticator.html) dùng thuật toán tự cài; phải khớp tuyệt đối với cổng admin.
const lib = createRequire(import.meta.url)('../../../tools/totp-lib.js') as {
  totp(secret: string, timeMs: number, digits?: number, step?: number): string;
  sha1(b: Uint8Array): Uint8Array;
  hmacSha1(k: Uint8Array, m: Uint8Array): Uint8Array;
  parseKey(s: string): string;
  base32Decode(s: string): Uint8Array;
};

describe('công cụ lấy mã xác thực độc lập', () => {
  it('SHA-1 và HMAC-SHA1 khớp thư viện crypto của Node (nhiều độ dài, kể cả sát ranh giới khối 64 byte)', () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const data = randomBytes(n);
      expect(Buffer.from(lib.sha1(data)).toString('hex')).toBe(createHash('sha1').update(data).digest('hex'));
      for (const kl of [1, 20, 64, 100]) {
        const key = randomBytes(kl);
        expect(Buffer.from(lib.hmacSha1(key, data)).toString('hex')).toBe(createHmac('sha1', key).update(data).digest('hex'));
      }
    }
  });

  it('khớp vector chuẩn RFC 6238 (SHA1, 8 chữ số)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(lib.totp(secret, 59_000, 8)).toBe('94287082');
    expect(lib.totp(secret, 1111111109_000, 8)).toBe('07081804');
    expect(lib.totp(secret, 1111111111_000, 8)).toBe('14050471');
    expect(lib.totp(secret, 1234567890_000, 8)).toBe('89005924');
    expect(lib.totp(secret, 2000000000_000, 8)).toBe('69279037');
  });

  it('khớp hàm TOTP của hệ thống trên 300 khóa và thời điểm ngẫu nhiên', () => {
    for (let i = 0; i < 300; i++) {
      const s = generateTotpSecret();
      const t = Math.floor(Math.random() * 4_000_000_000_000);
      expect(lib.totp(s, t)).toBe(totpAt(s, t));
    }
  });

  it('cùng mã trong cùng một chu kỳ 30 giây, khác mã ở chu kỳ kế tiếp', () => {
    const s = generateTotpSecret();
    const base = 1_700_000_010_000; // đầu chu kỳ + 10s
    expect(lib.totp(s, base)).toBe(lib.totp(s, base + 15_000));
    expect(lib.totp(s, base)).not.toBe(lib.totp(s, base + 30_000));
  });

  it('nhận khóa viết thường, có khoảng trắng/gạch, và đường dẫn otpauth', () => {
    const s = generateTotpSecret();
    const spaced = s.toLowerCase().replace(/(.{4})/g, '$1 ').trim();
    expect(lib.parseKey(spaced)).toBe(s);
    expect(lib.parseKey(`otpauth://totp/RentPro%20Admin:admin%40rentpro.local?secret=${s}&issuer=RentPro`)).toBe(s);
  });

  it('từ chối khóa sai bằng thông báo tiếng Việt', () => {
    expect(() => lib.parseKey('')).toThrow(/trống/);
    expect(() => lib.parseKey('ABC1!')).toThrow(/A-Z/);
    expect(() => lib.parseKey('ABCD')).toThrow(/quá ngắn/);
    expect(() => lib.parseKey('otpauth://totp/x?issuer=y')).toThrow(/secret/);
  });
});
