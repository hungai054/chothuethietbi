import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  ExtensionTimeoutError, SDK_VERSION, checkCompatibility, clearRegistry, defineExtension, getExtension, listExtensions, parseExtensionConfig, registerExtension, satisfies, tablePrefix,
  validateDefinition, validateMigrationSql, withTimeout, type ExtensionDefinition,
} from '../src';

const base = (over: Partial<ExtensionDefinition['manifest']> = {}, rest: Partial<ExtensionDefinition> = {}): ExtensionDefinition => defineExtension({
  manifest: { code: 'demo-shop', name: 'Demo', version: '1.2.3', sdk: '^1.0', hooks: [], ...over }, ...rest,
});

describe('phiên bản SDK', () => {
  it('so khớp dải phiên bản', () => {
    expect(satisfies('^1.0', '1.0.0')).toBe(true);
    expect(satisfies('^1.0', '1.9.4')).toBe(true);
    expect(satisfies('^1.2.3', '1.2.2')).toBe(false);
    expect(satisfies('^1.0', '2.0.0')).toBe(false);
    expect(satisfies('^1.0', '0.9.0')).toBe(false);
    expect(satisfies('1.x', '1.7.0')).toBe(true);
    expect(satisfies('1.x', '2.0.0')).toBe(false);
    expect(satisfies('>=1.1', '1.0.9')).toBe(false);
    expect(satisfies('>=1.1', '2.0.0')).toBe(true);
    expect(satisfies('~1.0', '1.0.1')).toBe(false); // dạng không hỗ trợ
    expect(satisfies('^1.0', 'khong-phai')).toBe(false);
  });
  it('kiểm tra tương thích báo lỗi tiếng Việt, dẫn tới tài liệu nâng cấp', () => {
    expect(checkCompatibility({ code: 'a-b', sdk: '^1.0' })).toBeNull();
    expect(checkCompatibility({ code: 'a-b', sdk: '^2.0' })).toMatch(/cần SDK \^2\.0 nhưng hệ thống đang dùng SDK 1\.0\.0.*CUSTOMIZATION/);
    expect(checkCompatibility({ code: 'a-b', sdk: 'moi-nhat' })).toMatch(/không hợp lệ/);
    expect(checkCompatibility({ code: 'a-b', sdk: '^1.5' }, '1.4.0')).toMatch(/cần SDK/);
    expect(SDK_VERSION).toBe('1.0.0');
  });
});

describe('kiểm tra định nghĩa', () => {
  it('định nghĩa tối thiểu hợp lệ', () => {
    expect(validateDefinition(base())).toEqual([]);
  });
  it('mã, phiên bản, tên', () => {
    expect(validateDefinition(base({ code: 'A_B' }))[0]).toMatch(/Mã extension/);
    expect(validateDefinition(base({ version: '1.2' }))[0]).toMatch(/x\.y\.z/);
    expect(validateDefinition(base({ name: ' ' }))[0]).toMatch(/Thiếu tên/);
  });
  it('móc khai báo phải khớp móc cài đặt; móc bắt buộc nằm trong danh sách và không là móc đồng bộ', () => {
    expect(validateDefinition(base({ hooks: ['pricing.adjust'] }))).toEqual(['Manifest khai báo móc "pricing.adjust" nhưng không cài đặt.']);
    expect(validateDefinition(base({}, { hooks: { 'pricing.adjust': () => [] } }))).toEqual(['Extension cài đặt móc "pricing.adjust" nhưng chưa khai báo trong manifest.hooks.']);
    expect(validateDefinition(base({ hooks: ['khong.co' as never] }))[0]).toMatch(/không tồn tại/);
    const ok = base({ hooks: ['booking.beforeCreate'], required: ['booking.beforeCreate'] }, { hooks: { 'booking.beforeCreate': () => undefined } });
    expect(validateDefinition(ok)).toEqual([]);
    expect(validateDefinition(base({ required: ['booking.afterConfirm'] }))).toContain('Móc bắt buộc "booking.afterConfirm" phải nằm trong danh sách hooks.');
    const sync = base({ hooks: ['pricing.adjust'], required: ['pricing.adjust'] }, { hooks: { 'pricing.adjust': () => [] } });
    expect(validateDefinition(sync)).toEqual(['Móc đồng bộ "pricing.adjust" không đặt bắt buộc được.']);
  });
  it('báo cáo, trang, tác vụ: khóa hợp lệ, không trùng, lịch hợp lệ', () => {
    const run = async () => ({ key: 'x', title: 'x', period: '', sections: [] });
    const d = base({}, {
      reports: [{ key: 'a', title: 'A', description: '', run }, { key: 'a', title: 'A2', description: '', run }, { key: 'Sai Khoa', title: 'x', description: '', run }],
      pages: [{ path: 'tong-quan', title: 'T', render: run }, { path: 'tong-quan', title: 'T2', render: run }],
      jobs: [{ name: 'dong-bo', schedule: { everyMinutes: 1 }, handler: async () => undefined }, { name: 'sang', schedule: { dailyAt: '25:00' }, handler: async () => undefined }, { name: 'ok', schedule: { dailyAt: '06:30' }, handler: async () => undefined }],
    });
    const errs = validateDefinition(d);
    expect(errs).toEqual(expect.arrayContaining([
      'Trùng khóa báo cáo "a".', 'Khóa báo cáo "Sai Khoa" không hợp lệ.', 'Trùng đường dẫn trang "tong-quan".',
      'Lịch của tác vụ "dong-bo" không hợp lệ (mỗi 5–10080 phút, hoặc dailyAt HH:MM).', 'Lịch của tác vụ "sang" không hợp lệ (mỗi 5–10080 phút, hoặc dailyAt HH:MM).',
    ]));
    expect(errs.filter((e) => !/Trùng|Khóa báo cáo|Lịch của tác vụ/.test(e))).toEqual([]);
  });
});

describe('migration của extension', () => {
  const prefix = tablePrefix('demo-shop');
  const good = `CREATE TABLE ${prefix}note (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, body text);
    CREATE INDEX ON ${prefix}note (tenant_id);
    ALTER TABLE ${prefix}note ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON ${prefix}note USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());`;
  it('tiền tố bảng theo mã', () => { expect(prefix).toBe('ext_demo_shop_'); });
  it('migration đúng quy tắc được chấp nhận', () => { expect(validateMigrationSql('demo-shop', good)).toBeNull(); });
  it('chặn bảng sai tiền tố, thiếu tenant_id, thiếu RLS/policy', () => {
    expect(validateMigrationSql('demo-shop', `CREATE TABLE booking_extra (tenant_id uuid)`)).toMatch(/tiền tố "ext_demo_shop_"/);
    expect(validateMigrationSql('demo-shop', `CREATE TABLE ${prefix}x (id uuid)`)).toMatch(/cột tenant_id/);
    expect(validateMigrationSql('demo-shop', `CREATE TABLE ${prefix}x (tenant_id uuid)`)).toMatch(/ROW LEVEL SECURITY/);
    expect(validateMigrationSql('demo-shop', `CREATE TABLE ${prefix}x (tenant_id uuid); ALTER TABLE ${prefix}x ENABLE ROW LEVEL SECURITY`)).toMatch(/policy/);
  });
  it('chặn sửa/xóa bảng lõi và các câu lệnh nguy hiểm', () => {
    for (const sql of ['ALTER TABLE booking ADD COLUMN x int', 'DROP TABLE customer', 'UPDATE booking SET total=0', 'DELETE FROM payment', 'GRANT ALL ON booking TO rentpro_app', 'TRUNCATE booking', 'INSERT INTO plan(code) VALUES (1)'])
      expect(validateMigrationSql('demo-shop', sql), sql).toMatch(/không được phép/);
    expect(validateMigrationSql('demo-shop', 'SELECT 1')).toMatch(/không được hỗ trợ/);
    expect(validateMigrationSql('demo-shop', '  ;  ')).toMatch(/rỗng/);
    expect(validateMigrationSql('demo-shop', `CREATE INDEX ON booking (id)`)).toMatch(/chỉ mục/);
    expect(validateMigrationSql('demo-shop', `ALTER TABLE booking ENABLE ROW LEVEL SECURITY`)).toMatch(/bật RLS/);
  });
  it('migration sai làm định nghĩa không hợp lệ', () => {
    expect(validateDefinition(base({ migrations: [{ id: '001', sql: 'DROP TABLE booking' }] }))[0]).toMatch(/Migration "001"/);
  });
});

describe('registry', () => {
  beforeEach(() => clearRegistry());
  it('đăng ký, tra cứu, từ chối đăng ký trùng và định nghĩa sai', () => {
    registerExtension(base());
    expect(getExtension('demo-shop')?.manifest.name).toBe('Demo');
    expect(listExtensions()).toHaveLength(1);
    expect(() => registerExtension(base())).toThrow(/đã được đăng ký/);
    expect(() => registerExtension(base({ code: 'khac', sdk: '^9.0' }))).toThrow(/Extension "khac" không hợp lệ:\n- .*cần SDK/);
    expect(listExtensions()).toHaveLength(1); // không nạp nửa chừng
  });
});

describe('cấu hình theo cửa hàng', () => {
  const d = base({}, { configSchema: z.object({ uplift: z.number().min(0).max(100).default(20) }).strict() });
  it('kiểm tra bằng schema, áp giá trị mặc định, báo lỗi tiếng Việt kèm đường dẫn', () => {
    expect(parseExtensionConfig(d, {})).toEqual({ ok: true, config: { uplift: 20 } });
    expect(parseExtensionConfig(d, { uplift: 35 })).toEqual({ ok: true, config: { uplift: 35 } });
    const bad = parseExtensionConfig(d, { uplift: 500 });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/uplift/);
    expect(parseExtensionConfig(d, { la: 1 }).ok).toBe(false);
    expect(parseExtensionConfig(d, [1])).toEqual({ ok: false, error: 'Cấu hình phải là một đối tượng JSON.' });
    expect(parseExtensionConfig(d, null)).toEqual({ ok: true, config: { uplift: 20 } });
  });
  it('extension không có schema thì không nhận cấu hình', () => {
    expect(parseExtensionConfig(base(), {})).toEqual({ ok: true, config: {} });
    expect(parseExtensionConfig(base(), { a: 1 })).toEqual({ ok: false, error: 'Extension này không có cấu hình.' });
  });
});

describe('cô lập lỗi', () => {
  it('trả kết quả, đẩy lỗi lên, và ngắt khi quá thời gian', async () => {
    expect(await withTimeout(async () => 7, 50)).toBe(7);
    expect(await withTimeout(() => 8, 50)).toBe(8);
    await expect(withTimeout(() => { throw new Error('hỏng'); }, 50)).rejects.toThrow('hỏng');
    await expect(withTimeout(() => new Promise((r) => setTimeout(r, 200)), 20)).rejects.toThrow(ExtensionTimeoutError);
    await expect(withTimeout(() => new Promise((r) => setTimeout(r, 200)), 20)).rejects.toThrow(/Quá thời gian chờ 20 ms/);
  });
});
