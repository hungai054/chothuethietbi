import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  API_ENDPOINTS, API_SCOPES, MAX_ATTEMPTS, PERMISSIONS, SCOPE_PERMISSIONS, buildOpenApi, generateApiKey, hashApiKey, isPrivateAddress, looksLikeApiKey, newWebhookSecret,
  parseBearer, permissionsForScopes, rateLimit, retryDelay, signWebhook, validateScopes, validateWebhookUrl, verifyWebhookSignature,
} from '../src';

describe('khóa API', () => {
  it('sinh khóa đúng định dạng, ngẫu nhiên, băm ổn định, tiền tố hiển thị không lộ khóa', () => {
    const a = generateApiKey((n) => randomBytes(n));
    const b = generateApiKey((n) => randomBytes(n));
    expect(looksLikeApiKey(a.key)).toBe(true);
    expect(a.key).not.toBe(b.key);
    expect(a.prefix.length).toBe(14);
    expect(a.key.startsWith(a.prefix)).toBe(true);
    expect(hashApiKey(a.key)).toBe(hashApiKey(a.key));
    expect(hashApiKey(a.key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(a.key)).not.toBe(hashApiKey(b.key));
  });
  it('mọi khóa/bí mật sinh ra đều đúng định dạng (không lệch bảng ký tự)', () => {
    for (let i = 0; i < 300; i++) {
      expect(looksLikeApiKey(generateApiKey((n) => randomBytes(n)).key)).toBe(true);
      expect(newWebhookSecret((n) => randomBytes(n))).toMatch(/^whsec_[A-Za-z0-9]{32}$/);
    }
  });
  it('phân tích header Bearer', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer abc')).toBe('abc');
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer('Bearer a b')).toBeNull();
    expect(looksLikeApiKey('rp_live_short')).toBe(false);
  });
  it('phạm vi → quyền; không bao giờ có quyền giấy tờ, tiền, cài đặt', () => {
    expect([...permissionsForScopes(['bookings:write'])].sort()).toEqual(['booking.create', 'booking.view', 'customer.view', 'pricing.view']);
    expect(permissionsForScopes(['khong-co']).size).toBe(0);
    const forbidden = ['customer.id_document.view', 'customer.anonymize', 'deposit.refund', 'payment.create', 'settings.manage', 'users.manage', 'billing.manage', 'data.export', 'data.delete'];
    for (const s of API_SCOPES) for (const p of SCOPE_PERMISSIONS[s]) {
      expect(PERMISSIONS as readonly string[]).toContain(p);
      expect(forbidden).not.toContain(p);
    }
  });
  it('kiểm tra phạm vi', () => {
    expect(validateScopes([])).toMatch(/ít nhất một/);
    expect(validateScopes(['inventory:read', 'x'])).toMatch(/không hợp lệ/);
    expect(validateScopes(['inventory:read'])).toBeNull();
  });
  it('giới hạn tốc độ cửa sổ trượt', () => {
    const hits = new Map<string, number[]>();
    for (let i = 0; i < 3; i++) expect(rateLimit(hits, 'k', 3, 60_000, 1000 + i)).toBe(0);
    expect(rateLimit(hits, 'k', 3, 60_000, 2000)).toBeGreaterThan(0);
    expect(rateLimit(hits, 'khac', 3, 60_000, 2000)).toBe(0);
    expect(rateLimit(hits, 'k', 3, 60_000, 62_000)).toBe(0);
  });
});

describe('webhook', () => {
  it('ký và kiểm tra: đúng, sai body, sai bí mật, quá hạn', () => {
    const body = '{"a":1}';
    const sig = signWebhook('whsec_x', 1_700_000_000, body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('whsec_x', 1_700_000_000, body, sig, 1_700_000_100)).toBe(true);
    expect(verifyWebhookSignature('whsec_x', 1_700_000_000, '{"a":2}', sig, 1_700_000_100)).toBe(false);
    expect(verifyWebhookSignature('whsec_y', 1_700_000_000, body, sig, 1_700_000_100)).toBe(false);
    expect(verifyWebhookSignature('whsec_x', 1_700_000_000, body, sig, 1_700_001_000)).toBe(false); // phát lại sau 5 phút
    expect(verifyWebhookSignature('whsec_x', 1_700_000_000, body, 'v1=ngan', 1_700_000_100)).toBe(false);
  });
  it('lịch thử lại tăng dần rồi hết lượt', () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelay(n))).toEqual([60, 300, 1800, 7200, 43_200]);
    expect(retryDelay(6)).toBeNull();
    expect(MAX_ATTEMPTS).toBe(6);
  });
  it('bí mật webhook đúng định dạng', () => {
    expect(newWebhookSecret((n) => randomBytes(n))).toMatch(/^whsec_[A-Za-z0-9]{32}$/);
  });
  it('nhận diện địa chỉ IP nội bộ', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '203.113.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });
  it('kiểm tra địa chỉ đích: HTTPS, không nội bộ, không mật khẩu, cổng hợp lệ', () => {
    expect(validateWebhookUrl('https://hooks.example.com/rentpro')).toBeNull();
    expect(validateWebhookUrl('https://hooks.example.com:8443/x')).toBeNull();
    expect(validateWebhookUrl('http://hooks.example.com/x')).toMatch(/HTTPS/);
    expect(validateWebhookUrl('https://localhost/x')).toMatch(/nội bộ/);
    expect(validateWebhookUrl('https://app.localhost/x')).toMatch(/nội bộ/);
    expect(validateWebhookUrl('https://192.168.1.10/x')).toMatch(/nội bộ/);
    expect(validateWebhookUrl('https://[::1]/x')).toMatch(/nội bộ/);
    expect(validateWebhookUrl('https://u:p@hooks.example.com/')).toMatch(/mật khẩu/);
    expect(validateWebhookUrl('https://hooks.example.com:22/')).toMatch(/cổng/);
    expect(validateWebhookUrl('khong phai url')).toMatch(/không hợp lệ/);
    expect(validateWebhookUrl('ftp://x.com/')).toMatch(/HTTPS/);
    expect(validateWebhookUrl('http://localhost:9000/x', { allowInsecure: true })).toBeNull();
  });
});

describe('OpenAPI', () => {
  it('sinh tài liệu từ bảng mô tả: mọi endpoint có phạm vi, tham số đường dẫn bắt buộc, lỗi chuẩn', () => {
    const doc = buildOpenApi({ baseUrl: 'https://x.vn' }) as any;
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths).length).toBe(new Set(API_ENDPOINTS.map((e) => e.path)).size);
    const get = doc.paths['/api/v1/bookings/{id}'].get;
    expect(get.security[0].bearerAuth).toEqual(['bookings:read']);
    expect(get.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(doc.paths['/api/v1/bookings'].post.responses['201']).toBeDefined();
    expect(doc.paths['/api/v1/bookings'].post.responses['401']).toBeDefined();
    expect(doc.paths['/api/v1/bookings'].post.requestBody.content['application/json'].schema.required).toContain('items');
    expect(doc.info.description).toContain('booking.created');
    const ids = API_ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
