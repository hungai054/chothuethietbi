import { describe, it, expect } from 'vitest';
import {
  crc16, buildVietQrPayload, parseTlv, verifyVietQr, sanitizeMemo, validateBankAccount, VietQrError, BANKS,
  vndInWords, computeSettlement, paymentStatus, suggestDeposit, applyDepositHook, DepositRuleSchema, upgradeFinanceSettings, FinanceSettingsSchema,
  compareHandover, buildContractContent, DEFAULT_TERMS, type HandoverItemData, type Settlement,
} from '../src';

describe('VietQR', () => {
  it('CRC-16/CCITT-FALSE khớp vector chuẩn', () => {
    expect(crc16('123456789')).toBe('29B1');
    expect(crc16('')).toBe('FFFF');
  });

  const base = { bin: '970415', account: '113366668888', amount: 1_250_000, memo: 'DT-2026-00001' };

  it('mã có đủ các trường, CRC hợp lệ, số tiền và nội dung đúng', () => {
    const p = buildVietQrPayload(base);
    expect(verifyVietQr(p)).toBe(true);
    const top = parseTlv(p);
    expect(top.map((t) => t.id)).toEqual(['00', '01', '38', '53', '54', '58', '62', '63']);
    const get = (id: string) => top.find((t) => t.id === id)!.value;
    expect(get('00')).toBe('01');
    expect(get('01')).toBe('12'); // có số tiền → động
    expect(get('53')).toBe('704');
    expect(get('54')).toBe('1250000');
    expect(get('58')).toBe('VN');
    const merchant = parseTlv(get('38'));
    expect(merchant.find((t) => t.id === '00')!.value).toBe('A000000727');
    expect(merchant.find((t) => t.id === '02')!.value).toBe('QRIBFTTA');
    const bene = parseTlv(merchant.find((t) => t.id === '01')!.value);
    expect(bene).toEqual([{ id: '00', value: '970415' }, { id: '01', value: '113366668888' }]);
    expect(parseTlv(get('62'))).toEqual([{ id: '08', value: 'DT-2026-00001' }]);
  });

  it('phát hiện mã bị sửa dù chỉ một ký tự', () => {
    const p = buildVietQrPayload(base);
    expect(verifyVietQr(p)).toBe(true);
    for (let i = 0; i < p.length - 4; i += 7) {
      const bad = p.slice(0, i) + (p[i] === '1' ? '2' : '1') + p.slice(i + 1);
      expect(verifyVietQr(bad)).toBe(false);
    }
    expect(verifyVietQr('rac')).toBe(false);
  });

  it('không có số tiền thì là mã tĩnh; không nội dung thì bỏ trường 62', () => {
    const p = buildVietQrPayload({ bin: base.bin, account: base.account });
    const ids = parseTlv(p).map((t) => t.id);
    expect(parseTlv(p).find((t) => t.id === '01')!.value).toBe('11');
    expect(ids).not.toContain('54');
    expect(ids).not.toContain('62');
    expect(verifyVietQr(p)).toBe(true);
  });

  it('nội dung được bỏ dấu và làm sạch', () => {
    expect(sanitizeMemo('Thuê máy ảnh - Đơn DT/2026#1')).toBe('THUE MAY ANH - DON DT 2026 1');
    expect(sanitizeMemo('   nhiều    khoảng    trắng ')).toBe('NHIEU KHOANG TRANG');
    expect(sanitizeMemo('x'.repeat(80))).toHaveLength(50);
    expect(parseTlv(parseTlv(buildVietQrPayload({ ...base, memo: 'Đơn thuê máy' })).find((t) => t.id === '62')!.value)[0]!.value).toBe('DON THUE MAY');
  });

  it('từ chối dữ liệu sai bằng thông báo tiếng Việt', () => {
    expect(() => buildVietQrPayload({ ...base, bin: '1234' })).toThrow(VietQrError);
    expect(() => buildVietQrPayload({ ...base, bin: '1234' })).toThrow(/6 chữ số/);
    expect(() => buildVietQrPayload({ ...base, account: '12ab' })).toThrow(/Số tài khoản/);
    expect(() => buildVietQrPayload({ ...base, amount: 0 })).toThrow(/số nguyên dương/);
    expect(() => buildVietQrPayload({ ...base, amount: 1.5 })).toThrow();
    expect(() => buildVietQrPayload({ ...base, amount: -5 })).toThrow();
    expect(validateBankAccount({ bin: '970436', account: '0123456789' })).toBeNull();
  });

  it('danh sách ngân hàng: mã BIN hợp lệ và không trùng', () => {
    expect(new Set(BANKS.map((b) => b.bin)).size).toBe(BANKS.length);
    for (const b of BANKS) expect(b.bin).toMatch(/^\d{6}$/);
  });
});

describe('số tiền bằng chữ', () => {
  const cases: [number, string][] = [
    [0, 'Không đồng'], [1, 'Một đồng'], [5, 'Năm đồng'], [10, 'Mười đồng'], [11, 'Mười một đồng'], [15, 'Mười lăm đồng'],
    [21, 'Hai mươi mốt đồng'], [25, 'Hai mươi lăm đồng'], [100, 'Một trăm đồng'], [101, 'Một trăm linh một đồng'], [105, 'Một trăm linh năm đồng'],
    [110, 'Một trăm mười đồng'], [115, 'Một trăm mười lăm đồng'], [999, 'Chín trăm chín mươi chín đồng'],
    [1_000, 'Một nghìn đồng'], [1_001, 'Một nghìn không trăm linh một đồng'], [12_000, 'Mười hai nghìn đồng'],
    [500_000, 'Năm trăm nghìn đồng'], [1_000_000, 'Một triệu đồng'], [1_250_000, 'Một triệu hai trăm năm mươi nghìn đồng'],
    [1_000_005, 'Một triệu không trăm linh năm đồng'], [2_000_000_000, 'Hai tỷ đồng'],
    [3_050_000_000, 'Ba tỷ không trăm năm mươi triệu đồng'], [55_000_000, 'Năm mươi lăm triệu đồng'],
  ];
  for (const [n, s] of cases) it(`${n.toLocaleString('vi-VN')} = ${s}`, () => expect(vndInWords(n)).toBe(s));
  it('từ chối số âm, số lẻ, quá lớn', () => {
    expect(() => vndInWords(-1)).toThrow();
    expect(() => vndInWords(1.5)).toThrow();
    expect(() => vndInWords(1e15)).toThrow();
  });
});

describe('quyết toán', () => {
  const S = (rentTotal: number, fees: number, paid: Parameters<typeof computeSettlement>[0]['paid']) => computeSettlement({ rentTotal, fees, paid });

  it('trả đủ tiền thuê, không cọc: đã quyết toán', () => {
    const s = S(1_000_000, 0, { RENT: 1_000_000 });
    expect(s).toMatchObject({ balanceOwed: 0, refundDue: 0, settled: true });
    expect(paymentStatus(s)).toBe('PAID');
  });
  it('cọc đủ trừ tiền thuê chưa trả: khấu trừ rồi hoàn phần dư', () => {
    const s = S(1_000_000, 0, { DEPOSIT: 2_000_000 });
    expect(s).toMatchObject({ depositHeld: 2_000_000, depositApplied: 1_000_000, refundDue: 1_000_000, balanceOwed: 0, settled: false });
    expect(paymentStatus(s)).toBe('PAID'); // cọc đủ bù tiền thuê
  });
  it('đã trả tiền thuê, cọc nguyên vẹn: hoàn toàn bộ cọc', () => {
    const s = S(1_000_000, 0, { RENT: 1_000_000, DEPOSIT: 2_000_000 });
    expect(s).toMatchObject({ depositApplied: 0, refundDue: 2_000_000, balanceOwed: 0 });
  });
  it('có phí phát sinh: trừ vào cọc rồi hoàn phần còn lại; hoàn xong thì đóng sổ', () => {
    let s = S(1_000_000, 300_000, { RENT: 1_000_000, DEPOSIT: 2_000_000 });
    expect(s).toMatchObject({ charges: 1_300_000, depositApplied: 300_000, refundDue: 1_700_000, balanceOwed: 0 });
    s = S(1_000_000, 300_000, { RENT: 1_000_000, DEPOSIT: 2_000_000, REFUND: 1_700_000 });
    expect(s).toMatchObject({ refundDue: 0, balanceOwed: 0, settled: true, depositHeld: 300_000, depositApplied: 300_000 });
  });
  it('cọc không đủ bù phí: khách còn phải trả thêm', () => {
    const s = S(1_000_000, 3_000_000, { RENT: 1_000_000, DEPOSIT: 2_000_000 });
    expect(s).toMatchObject({ depositApplied: 2_000_000, balanceOwed: 1_000_000, refundDue: 0, settled: false });
    expect(paymentStatus(s)).toBe('PARTIAL');
  });
  it('trả thêm phần thiếu thì đóng sổ', () => {
    expect(S(1_000_000, 3_000_000, { RENT: 1_000_000, DEPOSIT: 2_000_000, FEE: 1_000_000 })).toMatchObject({ balanceOwed: 0, refundDue: 0, settled: true });
  });
  it('xóa nợ có lý do làm giảm số phải thu', () => {
    const s = S(1_000_000, 3_000_000, { RENT: 1_000_000, DEPOSIT: 2_000_000, WRITE_OFF: 1_000_000 });
    expect(s).toMatchObject({ balanceOwed: 0, settled: true, writtenOff: 1_000_000 });
  });
  it('đơn hủy sau khi đã cọc: hoàn cọc rồi đóng sổ; trạng thái "đã hoàn tiền"', () => {
    let s = S(0, 0, { DEPOSIT: 500_000 });
    expect(s).toMatchObject({ refundDue: 500_000, settled: false });
    s = S(0, 0, { DEPOSIT: 500_000, REFUND: 500_000 });
    expect(s).toMatchObject({ refundDue: 0, settled: true });
    expect(paymentStatus(s)).toBe('REFUNDED');
  });
  it('chưa thu gì: chưa thanh toán; thu một phần: một phần', () => {
    expect(paymentStatus(S(1_000_000, 0, {}))).toBe('UNPAID');
    expect(paymentStatus(S(1_000_000, 0, { RENT: 400_000 }))).toBe('PARTIAL');
    expect(paymentStatus(S(0, 0, {}))).toBe('UNPAID');
  });
  it('thu thừa tiền thuê thì phải hoàn lại', () => {
    expect(S(1_000_000, 0, { RENT: 1_200_000 })).toMatchObject({ refundDue: 200_000, balanceOwed: 0 });
  });
  it('từ chối số tiền không hợp lệ', () => {
    expect(() => S(-1, 0, {})).toThrow(/không hợp lệ/);
    expect(() => S(1, 1.5, {})).toThrow();
    expect(() => S(1, 0, { RENT: -3 })).toThrow();
  });

  it('tính chất (ngẫu nhiên, hạt giống cố định): không bao giờ vừa nợ vừa phải hoàn; cân bằng sổ cái; đóng sổ đúng', () => {
    let seed = 20261014;
    const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
    const m = () => rnd(40) * 50_000;
    for (let t = 0; t < 2000; t++) {
      const rent = m(), fees = m();
      const paid = { RENT: m(), DEPOSIT: m(), FEE: m(), REFUND: rnd(4) === 0 ? m() : 0, WRITE_OFF: rnd(5) === 0 ? m() : 0 };
      const s: Settlement = computeSettlement({ rentTotal: rent, fees, paid });
      expect(s.balanceOwed === 0 || s.refundDue === 0).toBe(true);
      expect(s.balanceOwed - s.refundDue).toBe(rent + fees - paid.WRITE_OFF - (paid.RENT + paid.DEPOSIT + paid.FEE - paid.REFUND));
      expect(s.settled).toBe(s.balanceOwed === 0 && s.refundDue === 0);
      expect(s.depositApplied).toBeLessThanOrEqual(s.depositHeld);
      expect(s.depositApplied).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('gợi ý tiền cọc', () => {
  const ctx = { rentTotal: 1_234_567, equipmentValue: 55_000_000 };
  it('theo từng chế độ, làm tròn lên bội số 1.000', () => {
    expect(suggestDeposit({ mode: 'NONE' }, ctx)).toBe(0);
    expect(suggestDeposit({ mode: 'FIXED', value: 500_000 }, ctx)).toBe(500_000);
    expect(suggestDeposit({ mode: 'PERCENT_OF_VALUE', value: 30 }, ctx)).toBe(16_500_000);
    expect(suggestDeposit({ mode: 'PERCENT_OF_RENT', value: 50 }, ctx)).toBe(618_000); // 617.283,5 → làm tròn lên
  });
  it('quy tắc cấu hình được kiểm tra bằng schema', () => {
    expect(DepositRuleSchema.safeParse({ mode: 'FIXED', value: -1 }).success).toBe(false);
    expect(DepositRuleSchema.safeParse({ mode: 'PERCENT_OF_VALUE', value: 101 }).success).toBe(false);
    expect(DepositRuleSchema.safeParse({ mode: 'KHAC' }).success).toBe(false);
    expect(DepositRuleSchema.safeParse({ mode: 'NONE' }).success).toBe(true);
  });
  it('hook của extension đổi được mức cọc; lỗi hoặc giá trị sai thì dùng mức gốc', () => {
    expect(applyDepositHook(500_000, ctx, ({ suggested }) => suggested * 2).amount).toBe(1_000_000);
    expect(applyDepositHook(500_000, ctx, () => { throw new Error('boom'); })).toMatchObject({ amount: 500_000, warning: expect.stringContaining('boom') });
    expect(applyDepositHook(500_000, ctx, () => -1)).toMatchObject({ amount: 500_000, warning: expect.stringContaining('không hợp lệ') });
    expect(applyDepositHook(500_000, ctx, () => 1.5)).toMatchObject({ amount: 500_000 });
    expect(applyDepositHook(500_000, ctx)).toEqual({ amount: 500_000 });
  });
});

describe('cấu hình tài chính', () => {
  it('rỗng → mặc định; dữ liệu hỏng bị bỏ; khóa lạ bị từ chối', () => {
    expect(upgradeFinanceSettings(undefined)).toEqual({ v: 1 });
    expect(upgradeFinanceSettings({ bank: { bin: '12', account: 'x' } })).toEqual({ v: 1 });
    expect(upgradeFinanceSettings({ bank: { bin: '970415', account: '113366668888' }, deposit: { mode: 'FIXED', value: 300_000 } })).toMatchObject({ deposit: { mode: 'FIXED' } });
    expect(FinanceSettingsSchema.safeParse({ v: 1, khongCo: 1 }).success).toBe(false);
  });
});

describe('so sánh biên bản giao và nhận', () => {
  const it1 = (condition: HandoverItemData['condition'], accessories: HandoverItemData['accessories'] = []): HandoverItemData => ({ key: 'u1', label: 'CAM-000001', condition, accessories });
  it('không có vấn đề: trả đủ, cùng tình trạng', () => {
    expect(compareHandover([it1('GOOD')], [it1('GOOD')])).toEqual([]);
  });
  it('phát hiện thiếu thiết bị (không có hoặc đánh dấu mất)', () => {
    expect(compareHandover([it1('GOOD')], []).map((x) => x.kind)).toEqual(['MISSING_ITEM']);
    expect(compareHandover([it1('GOOD')], [it1('MISSING')]).map((x) => x.kind)).toEqual(['MISSING_ITEM']);
  });
  it('phát hiện xấu đi; hỏng sẵn từ lúc giao thì không tính lỗi của khách', () => {
    const w = compareHandover([it1('GOOD')], [it1('DAMAGED')]);
    expect(w).toHaveLength(1);
    expect(w[0]!.detail).toMatch(/Tốt.*Hư hỏng/);
    expect(compareHandover([it1('DAMAGED')], [it1('DAMAGED')])).toEqual([]);
    expect(compareHandover([it1('GOOD')], [it1('FAIR')])).toHaveLength(1);
    expect(compareHandover([it1('FAIR')], [it1('GOOD')])).toEqual([]); // tốt lên không phải vấn đề
  });
  it('phát hiện thiếu phụ kiện so với lúc giao', () => {
    const d = it1('GOOD', [{ name: 'Pin', expected: 2, actual: 2 }, { name: 'Sạc', expected: 1, actual: 1 }]);
    const r = it1('GOOD', [{ name: 'Pin', expected: 2, actual: 1 }, { name: 'Sạc', expected: 1, actual: 1 }]);
    const issues = compareHandover([d], [r]);
    expect(issues.map((x) => x.kind)).toEqual(['ACCESSORY_SHORT']);
    expect(issues[0]!.detail).toContain('Pin');
  });
  it('thiết bị lạ khi nhận được báo', () => {
    expect(compareHandover([], [it1('GOOD')]).map((x) => x.kind)).toEqual(['NOT_RECORDED_AT_DELIVERY']);
  });
});

describe('nội dung hợp đồng', () => {
  const c = buildContractContent({
    number: 'HD-2026-00001', date: new Date('2026-11-02T01:00:00Z'), timeZone: 'Asia/Ho_Chi_Minh',
    store: { name: 'Cửa hàng Demo', address: '1 Lê Lợi, Q1', phone: '0901000000' },
    customer: { type: 'PERSON', name: 'Nguyễn Văn An', phone: '0901234567', idDocument: { label: 'CCCD', last4: '3456' } },
    booking: { code: 'DT-2026-00001', start: new Date('2026-11-02T01:00:00Z'), end: new Date('2026-11-03T01:00:00Z') },
    items: [{ name: 'Sony A7 IV', qty: 1, units: ['CAM-000001'], lineTotal: 700_000 }], rentTotal: 700_000, depositRequired: 2_000_000,
  });
  it('có số tiền bằng chữ, ngày theo múi giờ cửa hàng, điều khoản mặc định', () => {
    expect(c.dateText).toBe('02/11/2026');
    expect(c.booking.startText).toContain('08:00');
    expect(c.money).toMatchObject({ rentWords: 'Bảy trăm nghìn đồng', depositWords: 'Hai triệu đồng' });
    expect(c.terms).toEqual([...DEFAULT_TERMS]);
    expect(c.v).toBe(1);
  });
  it('không in số giấy tờ đầy đủ; không có cọc thì không đọc số tiền cọc', () => {
    expect(Object.keys(c.customer.idDocument!).sort()).toEqual(['label', 'last4']);
    expect(c.customer.idDocument!.last4).toBe('3456');
    const noDep = buildContractContent({ ...{ number: 'HD-1', date: new Date(), timeZone: 'UTC', store: { name: 'X' }, customer: { type: 'PERSON', name: 'A', phone: '0901234567' }, booking: { code: 'D', start: new Date(), end: new Date() }, items: [] }, rentTotal: 0, depositRequired: 0 });
    expect(noDep.money.depositWords).toBeNull();
  });
});
