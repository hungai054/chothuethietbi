import { describe, it, expect } from 'vitest';
import { createTestContext, parseExtensionConfig, validateDefinition, type Quote } from '@rentpro/extension-sdk';
import ext, { weekendHours } from '../src';

const TZ = 'Asia/Ho_Chi_Minh';
const at = (s: string) => new Date(s);
const q = (subtotal: number) => ({ subtotal } as Quote);

describe('weekendHours', () => {
  it('ngày thường = 0, trọn thứ Bảy = 24', () => {
    expect(weekendHours(at('2027-03-08T08:00:00+07:00'), at('2027-03-09T08:00:00+07:00'), TZ)).toBe(0); // Thứ Hai → Thứ Ba
    expect(weekendHours(at('2027-03-13T00:00:00+07:00'), at('2027-03-14T00:00:00+07:00'), TZ)).toBe(24); // Thứ Bảy
  });
  it('vắt qua ranh giới thứ Sáu → thứ Bảy và Chủ nhật → thứ Hai', () => {
    expect(weekendHours(at('2027-03-12T20:00:00+07:00'), at('2027-03-13T08:00:00+07:00'), TZ)).toBe(8);
    expect(weekendHours(at('2027-03-14T20:00:00+07:00'), at('2027-03-15T08:00:00+07:00'), TZ)).toBe(4);
  });
  it('tính theo múi giờ cửa hàng, không theo UTC', () => {
    // 01:00 sáng thứ Bảy giờ VN = 18:00 thứ Sáu UTC
    expect(weekendHours(at('2027-03-13T01:00:00+07:00'), at('2027-03-13T03:00:00+07:00'), TZ)).toBe(2);
    expect(weekendHours(at('2027-03-13T01:00:00+07:00'), at('2027-03-13T03:00:00+07:00'), 'UTC')).toBe(0);
  });
  it('khoảng không tròn giờ và thuê nhiều tuần', () => {
    expect(weekendHours(at('2027-03-13T10:30:00+07:00'), at('2027-03-13T12:15:00+07:00'), TZ)).toBeCloseTo(1.75, 5);
    expect(weekendHours(at('2027-03-01T00:00:00+07:00'), at('2027-03-15T00:00:00+07:00'), TZ)).toBe(96); // hai cuối tuần
    expect(weekendHours(at('2027-03-13T10:00:00+07:00'), at('2027-03-13T10:00:00+07:00'), TZ)).toBe(0);
  });
});

describe('demo-weekend', () => {
  it('định nghĩa hợp lệ; cấu hình mặc định và kiểm tra', () => {
    expect(validateDefinition(ext)).toEqual([]);
    expect(parseExtensionConfig(ext, {})).toEqual({ ok: true, config: { uplift: 20, label: 'Phụ thu cuối tuần' } });
    expect(parseExtensionConfig(ext, { uplift: 150 }).ok).toBe(false);
  });
  const hook = (cfg: Record<string, unknown>, subtotal: number, s: string, e: string) =>
    ext.hooks!['pricing.adjust']!(createTestContext({ config: { uplift: 20, label: 'Phụ thu cuối tuần', ...cfg } }), q(subtotal), { start: at(s), end: at(e) });
  it('thuê trọn thứ Bảy: phụ thu 20% toàn bộ tiền thuê', () => {
    expect(hook({}, 500_000, '2027-03-13T00:00:00+07:00', '2027-03-14T00:00:00+07:00')).toEqual([{ label: 'Phụ thu cuối tuần (20% × 100% thời gian)', amount: 100_000, source: 'extension' }]);
  });
  it('thuê một nửa rơi vào cuối tuần: phụ thu theo tỷ lệ, làm tròn 1.000 đ', () => {
    // Thứ Sáu 12:00 → Thứ Bảy 12:00: 12/24 giờ ở cuối tuần
    expect(hook({}, 500_000, '2027-03-12T12:00:00+07:00', '2027-03-13T12:00:00+07:00')[0]!.amount).toBe(50_000);
    expect(hook({}, 333_333, '2027-03-12T12:00:00+07:00', '2027-03-13T12:00:00+07:00')[0]!.amount).toBe(33_000);
  });
  it('ngày thường hoặc mức 0% thì không phụ thu; khoảng thời gian sai thì bỏ qua', () => {
    expect(hook({}, 500_000, '2027-03-08T08:00:00+07:00', '2027-03-09T08:00:00+07:00')).toEqual([]);
    expect(hook({ uplift: 0 }, 500_000, '2027-03-13T00:00:00+07:00', '2027-03-14T00:00:00+07:00')).toEqual([]);
    expect(hook({}, 500_000, '2027-03-14T00:00:00+07:00', '2027-03-13T00:00:00+07:00')).toEqual([]);
  });
  it('nhãn tùy chỉnh theo cửa hàng', () => {
    expect(hook({ label: 'Phụ thu lễ', uplift: 10 }, 1_000_000, '2027-03-13T00:00:00+07:00', '2027-03-14T00:00:00+07:00')[0]!.label).toBe('Phụ thu lễ (10% × 100% thời gian)');
  });
  it('báo cáo gom theo thứ và tính tỷ trọng cuối tuần', async () => {
    const ctx = createTestContext({ query: () => [{ dow: 1, n: 2, total: '1000000' }, { dow: 6, n: 1, total: '600000' }, { dow: 7, n: 1, total: '400000' }] });
    const r = await ext.reports![0]!.run(ctx, {});
    expect(r.sections[0]!.rows).toHaveLength(7);
    expect(r.sections[0]!.totals).toMatchObject({ n: 4, total: 2_000_000 });
    expect(r.cards![0]).toMatchObject({ label: 'Tỷ trọng cuối tuần', value: 0.5 });
    expect((await ext.reports![0]!.run(createTestContext(), {})).cards![0]!.value).toBe(0); // chưa có đơn: không chia cho 0
  });
  it('tác vụ nền ghi dấu vào kho riêng', async () => {
    const ctx = createTestContext();
    await ext.jobs![0]!.handler(ctx);
    expect(typeof ctx.store.data.get('lan-chay-cuoi')).toBe('string');
  });
});
