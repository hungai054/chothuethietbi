import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  AGING_BUCKETS, ReportFilterError, agingBucket, describePeriod, ratio, reportToXlsx, resolveRange, roi, sheetName, utilization, utilizationHint, type ReportResult,
} from '../src';

const TZ = 'Asia/Ho_Chi_Minh';
const now = new Date('2027-03-15T10:00:00+07:00');

describe('khoảng thời gian báo cáo', () => {
  it('mặc định từ đầu tháng đến hôm nay, tính trọn ngày theo múi giờ cửa hàng', () => {
    const r = resolveRange({}, TZ, now);
    expect([r.fromKey, r.toKey, r.days]).toEqual(['2027-03-01', '2027-03-15', 15]);
    expect(r.from.toISOString()).toBe(new Date('2027-03-01T00:00:00+07:00').toISOString());
    expect(r.to.toISOString()).toBe(new Date('2027-03-16T00:00:00+07:00').toISOString()); // không gồm ngày sau
  });
  it('ngày tự chọn; một ngày; toàn bộ lịch sử', () => {
    expect(resolveRange({ from: '2027-01-31', to: '2027-02-01' }, TZ, now).days).toBe(2);
    expect(resolveRange({ from: '2027-03-05', to: '2027-03-05' }, TZ, now).days).toBe(1);
    const all = resolveRange({}, TZ, now, 'all');
    expect(all.fromKey).toBe('2000-01-01');
    expect(describePeriod(all)).toBe('đến 15/03/2027');
    expect(describePeriod(resolveRange({ from: '2027-03-01', to: '2027-03-31' }, TZ, now))).toBe('01/03/2027 – 31/03/2027');
  });
  it('gần nửa đêm vẫn đúng ngày địa phương (UTC còn là hôm trước)', () => {
    const r = resolveRange({}, TZ, new Date('2027-03-15T23:30:00+07:00')); // 16:30 UTC cùng ngày
    expect(r.toKey).toBe('2027-03-15');
    expect(resolveRange({}, TZ, new Date('2027-03-16T00:10:00+07:00')).toKey).toBe('2027-03-16'); // 17:10 UTC hôm trước
  });
  it('báo lỗi tiếng Việt khi sai định dạng, sai ngày, đảo ngược hoặc quá dài', () => {
    expect(() => resolveRange({ from: '15/03/2027' }, TZ, now)).toThrow(/Ngày bắt đầu không hợp lệ/);
    expect(() => resolveRange({ to: '2027-02-30' }, TZ, now)).toThrow(/Ngày kết thúc không hợp lệ/);
    expect(() => resolveRange({ from: '2027-03-10', to: '2027-03-01' }, TZ, now)).toThrow(ReportFilterError);
    expect(() => resolveRange({ from: '2010-01-01', to: '2027-03-01' }, TZ, now)).toThrow(/tối đa 10 năm/);
  });
});

describe('phép tính', () => {
  it('tuổi nợ', () => {
    expect([0, 7, 7.9, 8, 30, 31, 400, -3].map(agingBucket)).toEqual([AGING_BUCKETS[0], AGING_BUCKETS[0], AGING_BUCKETS[0], AGING_BUCKETS[1], AGING_BUCKETS[1], AGING_BUCKETS[2], AGING_BUCKETS[2], AGING_BUCKETS[0]]);
  });
  it('mức sử dụng giới hạn 0..1, mẫu số 0 an toàn', () => {
    expect(utilization(12, 48)).toBe(0.25);
    expect(utilization(100, 48)).toBe(1);
    expect(utilization(-5, 48)).toBe(0);
    expect(utilization(5, 0)).toBe(0);
    expect(ratio(1, 0)).toBe(0);
    expect(ratio(1, 4)).toBe(0.25);
  });
  it('gợi ý thanh lý / mua thêm', () => {
    expect(utilizationHint({ modelUtilization: 0.3, unitUtilization: 0.05, unitAgeDays: 200 })).toMatch(/thanh lý/);
    expect(utilizationHint({ modelUtilization: 0.3, unitUtilization: 0.05, unitAgeDays: 30 })).toBeNull(); // thiết bị còn mới
    expect(utilizationHint({ modelUtilization: 0.85, unitUtilization: 0.9, unitAgeDays: 200 })).toMatch(/mua thêm/);
    expect(utilizationHint({ modelUtilization: 0.5, unitUtilization: 0.5, unitAgeDays: 500 })).toBeNull();
  });
  it('hoàn vốn: doanh thu trừ chi phí so với giá nhập', () => {
    expect(roi({ revenue: 12_000_000, cost: 2_000_000, purchasePrice: 20_000_000 })).toEqual({ net: 10_000_000, roi: 0.5, paidBack: false, remaining: 10_000_000 });
    expect(roi({ revenue: 30_000_000, cost: 5_000_000, purchasePrice: 20_000_000 })).toMatchObject({ paidBack: true, remaining: 0, roi: 1.25 });
    expect(roi({ revenue: 1_000_000, cost: 3_000_000, purchasePrice: 10_000_000 }).roi).toBeCloseTo(-0.2); // lỗ
    expect(roi({ revenue: 5, cost: 1, purchasePrice: null })).toEqual({ net: 4, roi: null, paidBack: null, remaining: null });
    expect(roi({ revenue: 5, cost: 1, purchasePrice: 0 }).roi).toBeNull();
  });
});

describe('xuất Excel', () => {
  const report: ReportResult = {
    key: 'revenue', title: 'Doanh thu', period: '01/03/2027 – 15/03/2027',
    cards: [{ label: 'Tổng doanh thu', value: 1_500_000, type: 'money', hint: 'ghi nhận' }],
    sections: [
      { title: 'Theo ngày', columns: [{ key: 'd', label: 'Ngày', type: 'text' }, { key: 'v', label: 'Doanh thu', type: 'money' }, { key: 'p', label: 'Tỷ lệ', type: 'percent' }],
        rows: [{ d: '01/03', v: 1_000_000, p: 0.25 }, { d: '=HYPERLINK("http://x")', v: 500_000, p: null }], totals: { d: 'Tổng', v: 1_500_000, p: null }, note: 'Ghi chú phần' },
      { title: 'Theo ngày', columns: [{ key: 'a', label: 'A', type: 'int' }], rows: [] },
    ],
    notes: ['Số liệu tham khảo'],
  };
  it('tạo sổ làm việc: sheet tổng quan, mỗi phần một sheet (tên không trùng), số giữ kiểu số', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await reportToXlsx(report) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Tổng quan', 'Theo ngày', 'Theo ngày 2', 'Ghi chú']);
    const ws = wb.getWorksheet('Theo ngày')!;
    expect(ws.getCell('A1').value).toBe('Doanh thu');
    expect(ws.getCell('A2').value).toBe('Kỳ: 01/03/2027 – 15/03/2027');
    const header = ws.getRow(6).values as unknown[];
    expect(header.slice(1)).toEqual(['Ngày', 'Doanh thu', 'Tỷ lệ']);
    expect(ws.getCell('B7').value).toBe(1_000_000);
    expect(typeof ws.getCell('B7').value).toBe('number');
    expect(ws.getCell('B7').numFmt).toBe('#,##0');
    expect(ws.getCell('C7').numFmt).toBe('0.0%');
    expect(ws.getCell('A9').value).toBe('Tổng');
    expect(wb.getWorksheet('Tổng quan')!.getCell('B5').value).toBe(1_500_000);
  });
  it('chặn công thức chèn từ dữ liệu: ô chữ bắt đầu bằng "=" được lưu như văn bản', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await reportToXlsx(report) as never);
    const v = wb.getWorksheet('Theo ngày')!.getCell('A8').value;
    expect(typeof v).toBe('string');
    expect(String(v).startsWith("'=")).toBe(true);
  });
  it('báo cáo rỗng vẫn ra file hợp lệ; tên sheet được làm sạch', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await reportToXlsx({ key: 'x', title: 'T', period: '', sections: [] }) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Trống']);
    const used = new Set<string>();
    expect(sheetName('Doanh thu: theo/ngày? [A]*', used)).toBe('Doanh thu  theo ngày   A');
    expect(sheetName('x'.repeat(50), used)).toHaveLength(31);
    expect(sheetName('x'.repeat(50), used)).toHaveLength(31); // trùng tên sau khi cắt vẫn khác nhau
    expect(used.size).toBe(3);
  });
});
