import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs, type Opts } from './ctx';
import {
  clearRule, createCustomer, createGroup, createModel, createPriceList, ensureDefaultPriceList, getPricingSettings, listPriceLists, listRules,
  quoteForCustomer, setBlacklist, setRule, updatePricingSettings, ReadOnlyError, withTenantId, ValidationError,
} from '../src';
import { ForbiddenError, type PriceRule } from '@rentpro/core';
import { FeatureDisabledError } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54333);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);

const RULE: PriceRule = { hour: 100_000, day: 500_000, week: 2_500_000, month: 8_000_000, minHours: 0 };
const START = new Date('2026-11-02T01:00:00Z');
const at = (h: number) => new Date(START.getTime() + h * 3_600_000);

async function shop() {
  const A = await mkTenant(t);
  const model = await as(A, {}, (c) => createModel(c, { name: 'Sony A7' }));
  const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
  await as(A, {}, (c) => setRule(c, list, model, RULE));
  return { A, model, list };
}

describe('bảng giá', () => {
  it('bảng giá mặc định tự tạo một lần duy nhất, ngay cả khi gọi đồng thời', async () => {
    const A = await mkTenant(t);
    const ids = await Promise.allSettled(Array.from({ length: 5 }, () => as(A, {}, (c) => ensureDefaultPriceList(c))));
    // Ràng buộc DB chặn tạo hai bảng mặc định; chỉ cần cuối cùng có đúng một
    expect(ids.some((r) => r.status === 'fulfilled')).toBe(true);
    expect((await as(A, {}, (c) => listPriceLists(c))).filter((l) => l.isDefault)).toHaveLength(1);
    expect((await t.admin.query('SELECT count(*)::int AS n FROM price_list WHERE tenant_id=$1 AND is_default', [A])).rows[0].n).toBe(1);
  });

  it('đặt, sửa, xóa giá; kiểm tra giá trị bằng tiếng Việt', async () => {
    const { A, model, list } = await shop();
    const rules = await as(A, {}, (c) => listRules(c, list));
    expect(rules[0]).toMatchObject({ modelName: 'Sony A7', rule: RULE });
    await as(A, {}, (c) => setRule(c, list, model, { ...RULE, day: 450_000 }));
    expect((await as(A, {}, (c) => listRules(c, list)))[0]!.rule!.day).toBe(450_000);
    await expect(as(A, {}, (c) => setRule(c, list, model, { ...RULE, day: -1 }))).rejects.toThrow(/số nguyên không âm/);
    await expect(as(A, {}, (c) => setRule(c, list, model, { hour: null, day: null, week: null, month: null, minHours: 0 }))).rejects.toThrow(/ít nhất một mức giá/);
    await as(A, {}, (c) => clearRule(c, list, model));
    expect((await as(A, {}, (c) => listRules(c, list)))[0]!.rule).toBeNull();
  });

  it('DB cũng chặn giá âm/rỗng dù gọi thẳng', async () => {
    const { A, model, list } = await shop();
    await expect(withTenantId(t.app, A, (db) => db.query('UPDATE price_rule SET day_price=-5 WHERE model_id=$1', [model]))).rejects.toThrow(/check/i);
    await expect(withTenantId(t.app, A, (db) => db.query('UPDATE price_rule SET hour_price=NULL, day_price=NULL, week_price=NULL, month_price=NULL WHERE price_list_id=$1', [list]))).rejects.toThrow(/check/i);
  });

  it('quyền: nhân viên quầy xem được nhưng không sửa giá; gói tắt thì chặn', async () => {
    const { A, model, list } = await shop();
    await expect(as(A, { role: 'STAFF' }, (c) => listRules(c, list))).resolves.toHaveLength(1);
    await expect(as(A, { role: 'STAFF' }, (c) => setRule(c, list, model, RULE))).rejects.toThrow(ForbiddenError);
    await expect(as(A, { role: 'MANAGER' }, (c) => setRule(c, list, model, RULE))).resolves.toBeUndefined();
    await expect(as(A, { off: ['pricing'] }, (c) => listRules(c, list))).rejects.toThrow(FeatureDisabledError);
    await expect(as(A, { status: 'READ_ONLY' }, (c) => setRule(c, list, model, RULE))).rejects.toThrow(ReadOnlyError);
  });

  it('cô lập tenant: không đặt giá cho mẫu/bảng giá của tenant khác', async () => {
    const { A, model, list } = await shop();
    const B = await mkTenant(t);
    await expect(as(B, {}, (c) => setRule(c, list, model, RULE))).rejects.toThrow(/Không tìm thấy/);
    expect(await as(B, {}, (c) => listPriceLists(c))).toEqual([]);
    expect((await as(A, {}, (c) => listRules(c, list)))[0]!.rule).toEqual(RULE);
  });
});

describe('báo giá theo khách', () => {
  it('báo giá theo bảng mặc định: 25 giờ = 1 ngày + 1 giờ', async () => {
    const { A, model } = await shop();
    const r = await as(A, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: START, end: at(25) }));
    expect(r.quote.total).toBe(600_000);
    expect(r.priceListName).toBe('Giá niêm yết');
  });

  it('mẫu chưa có giá: báo lỗi chỉ rõ tên mẫu', async () => {
    const { A } = await shop();
    const m2 = await as(A, {}, (c) => createModel(c, { name: 'Lens 50mm' }));
    await expect(as(A, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: m2, qty: 1 }], start: START, end: at(5) }))).rejects.toThrow(/"Lens 50mm" chưa có bảng giá/);
    await expect(as(A, {}, (c) => quoteForCustomer(c, { lines: [], start: START, end: at(5) }))).rejects.toThrow(/Chưa chọn thiết bị/);
  });

  it('lỗi tính giá được đổi thành thông báo tiếng Việt cho người dùng', async () => {
    const { A, model } = await shop();
    const e = await as(A, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: START, end: START })).catch((x) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.message).toMatch(/sau thời gian bắt đầu/);
  });

  it('nhóm khách dùng bảng giá riêng, mẫu thiếu giá thì dùng bảng mặc định; giảm giá của nhóm tự áp dụng', async () => {
    const { A, model } = await shop();
    const lens = await as(A, {}, (c) => createModel(c, { name: 'Lens 50mm' }));
    const def = await as(A, {}, (c) => ensureDefaultPriceList(c));
    await as(A, {}, (c) => setRule(c, def, lens, { hour: null, day: 200_000, week: null, month: null, minHours: 0 }));
    const partner = await as(A, {}, (c) => createPriceList(c, 'Giá đối tác'));
    await as(A, {}, (c) => setRule(c, partner, model, { ...RULE, day: 400_000 })); // chỉ có giá Sony, không có giá lens
    const g = await as(A, {}, (c) => createGroup(c, { name: 'Đối tác', discountPercent: 10, priceListId: partner }));
    const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Studio ABC', phone: '0933333333', groupId: g }));

    const r = await as(A, {}, (c) => quoteForCustomer(c, { customerId: cust, lines: [{ modelId: model, qty: 1 }, { modelId: lens, qty: 1 }], start: START, end: at(24) }));
    expect(r.priceListName).toBe('Giá đối tác');
    expect(r.groupName).toBe('Đối tác');
    expect(r.usedFallbackFor).toEqual(['Lens 50mm']);
    expect(r.quote.lines.map((l) => l.total)).toEqual([400_000, 200_000]);
    expect(r.quote.subtotal).toBe(600_000);
    expect(r.quote.discount).toMatchObject({ amount: 60_000, label: expect.stringContaining('Đối tác') });
    expect(r.quote.total).toBe(540_000);

    // giảm giá chọn tay thay cho giảm giá nhóm
    const manual = await as(A, {}, (c) => quoteForCustomer(c, { customerId: cust, lines: [{ modelId: model, qty: 1 }], start: START, end: at(24), discount: { type: 'AMOUNT', value: 50_000 } }));
    expect(manual.quote.total).toBe(350_000);
    // khách lẻ không có nhóm: giá niêm yết, không giảm
    const retail = await as(A, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: START, end: at(24) }));
    expect(retail.quote.total).toBe(500_000);
  });

  it('khách trong danh sách đen bị từ chối báo giá', async () => {
    const { A, model } = await shop();
    const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Khách xấu', phone: '0944444444' }));
    await as(A, {}, (c) => setBlacklist(c, cust, true, 'Quỵt tiền'));
    await expect(as(A, {}, (c) => quoteForCustomer(c, { customerId: cust, lines: [{ modelId: model, qty: 1 }], start: START, end: at(5) }))).rejects.toThrow(/danh sách đen: Quỵt tiền/);
  });

  it('không dùng được khách hoặc mẫu của tenant khác', async () => {
    const { A, model } = await shop();
    const B = await mkTenant(t);
    const custB = await as(B, {}, (c) => createCustomer(c, { name: 'Khách B', phone: '0955555555' }));
    await expect(as(A, {}, (c) => quoteForCustomer(c, { customerId: custB, lines: [{ modelId: model, qty: 1 }], start: START, end: at(5) }))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(B, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: START, end: at(5) }))).rejects.toThrow(/Không tìm thấy/);
  });

  it('hook giá của extension được áp dụng; hook lỗi không làm hỏng báo giá', async () => {
    const { A, model } = await shop();
    const hook = (q: { subtotal: number }) => [{ label: 'Phụ thu cuối tuần +20%', amount: Math.round(q.subtotal * 0.2), source: 'extension' as const }];
    const r = await as(A, { hook: hook as never }, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: START, end: at(24) }));
    expect(r.quote.total).toBe(600_000);
    expect(r.quote.adjustments[0]!.label).toMatch(/cuối tuần/);
    const bad = await as(A, { hook: (() => { throw new Error('lỗi extension'); }) as never }, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: START, end: at(24) }));
    expect(bad.quote.total).toBe(500_000);
    expect(bad.quote.warnings[0]).toMatch(/lỗi extension/);
  });
});

describe('cấu hình giá của cửa hàng', () => {
  it('mặc định rỗng; cập nhật được lưu và ảnh hưởng báo giá (VAT, ngày lịch)', async () => {
    const { A, model } = await shop();
    expect(await as(A, {}, (c) => getPricingSettings(c))).toEqual({ v: 1 });
    await as(A, {}, (c) => updatePricingSettings(c, { vatEnabled: true, vatPercent: 8, dayMode: 'CALENDAR', graceMinutes: 15 }));
    expect(await as(A, {}, (c) => getPricingSettings(c))).toMatchObject({ vatEnabled: true, vatPercent: 8, dayMode: 'CALENDAR', graceMinutes: 15 });
    // 08:00 → 18:00 cùng ngày: tính giờ nhưng không vượt giá ngày; +8% VAT
    const r = await as(A, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: START, end: at(10) }));
    expect(r.quote).toMatchObject({ subtotal: 500_000, vat: 40_000, total: 540_000 });
    // qua đêm 22:00 → 08:00: chạm 2 ngày lịch
    const night = await as(A, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: new Date('2026-11-02T15:00:00Z'), end: new Date('2026-11-03T01:00:00Z') }));
    expect(night.quote.calendarDays).toBe(2);
    expect(night.quote.subtotal).toBe(1_000_000);
  });

  it('múi giờ của cửa hàng quyết định ngày lịch', async () => {
    const { A, model } = await shop();
    await as(A, {}, (c) => updatePricingSettings(c, { dayMode: 'CALENDAR' }));
    await t.admin.query("UPDATE tenant SET timezone='UTC' WHERE id=$1", [A]);
    // 23:00Z → 02:00Z hôm sau: UTC chạm 2 ngày, còn giờ VN thì chỉ 1 ngày
    const utc = await as(A, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: new Date('2026-11-02T23:00:00Z'), end: new Date('2026-11-03T02:00:00Z') }));
    expect(utc.quote.calendarDays).toBe(2);
    await t.admin.query("UPDATE tenant SET timezone='Asia/Ho_Chi_Minh' WHERE id=$1", [A]);
    const vn = await as(A, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: new Date('2026-11-02T23:00:00Z'), end: new Date('2026-11-03T02:00:00Z') }));
    expect(vn.quote.calendarDays).toBe(1);
  });

  it('từ chối giá trị sai và khóa lạ; chỉ quản lý trở lên được sửa', async () => {
    const { A } = await shop();
    await expect(as(A, {}, (c) => updatePricingSettings(c, { graceMinutes: -5 }))).rejects.toThrow();
    await expect(as(A, {}, (c) => updatePricingSettings(c, { vatPercent: 500 }))).rejects.toThrow();
    await expect(as(A, {}, (c) => updatePricingSettings(c, { khongCo: 1 }))).rejects.toThrow();
    await expect(as(A, {}, (c) => updatePricingSettings(c, { lateFee: { mode: 'PER_HOUR' } }))).rejects.toThrow();
    await expect(as(A, { role: 'STAFF' }, (c) => updatePricingSettings(c, { vatEnabled: true }))).rejects.toThrow(ForbiddenError);
    await expect(as(A, { role: 'STAFF' }, (c) => getPricingSettings(c))).resolves.toBeDefined();
    await expect(as(A, { role: 'MANAGER' }, (c) => updatePricingSettings(c, { vatEnabled: true }))).resolves.toBeDefined();
  });

  it('cấu hình hỏng trong DB không làm hỏng báo giá (rơi về mặc định)', async () => {
    const { A, model } = await shop();
    await t.admin.query(`UPDATE tenant SET settings='{"pricing":{"v":1,"graceMinutes":"abc","vatPercent":-9}}' WHERE id=$1`, [A]);
    const r = await as(A, {}, (c) => quoteForCustomer(c, { lines: [{ modelId: model, qty: 1 }], start: START, end: at(24) }));
    expect(r.quote.total).toBe(500_000);
  });

  it('chỉ sửa được cấu hình của chính tenant mình; không sửa được cột khác của tenant', async () => {
    const { A } = await shop();
    const B = await mkTenant(t);
    await as(A, {}, (c) => updatePricingSettings(c, { vatEnabled: true }));
    expect(await as(B, {}, (c) => getPricingSettings(c))).toEqual({ v: 1 });
    await expect(withTenantId(t.app, A, (db) => db.query("UPDATE tenant SET status='ACTIVE', plan_id=plan_id"))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, A, (db) => db.query('UPDATE tenant SET feature_overrides=$1', ['{}']))).rejects.toThrow(/permission denied/);
    const other = await withTenantId(t.app, A, (db) => db.query('UPDATE tenant SET settings_version=settings_version WHERE id=$1', [B]));
    expect(other.rowCount).toBe(0);
  });
});
