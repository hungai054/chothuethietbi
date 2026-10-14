import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { collectStoragePaths, exportReadme, exportableRow, redactSecrets, tablesToXlsx } from '../src';

const T = '11111111-1111-1111-1111-111111111111';

describe('xuất dữ liệu cửa hàng', () => {
  it('bỏ cột nhạy cảm', () => {
    expect(exportableRow({ id: 1, name: 'A', password_hash: 'x', number_enc: 'y', number_hash: 'z', totp_secret: 't' })).toEqual({ id: 1, name: 'A' });
  });
  it('ẩn bí mật trong cấu hình lồng nhau, giữ phần còn lại', () => {
    const out = redactSecrets({ finance: { bank: { account: '123' } }, notify: { smtp: { host: 'h', pass: 'p', apiKey: 'k', secret_enc: 's' }, esms: { secretKey: 'sk', accessToken: 'tk', brandname: 'B' } }, list: [{ token: 'a', ok: 1 }] }) as Record<string, any>;
    expect(out.finance.bank.account).toBe('123');
    expect(out.notify.smtp).toEqual({ host: 'h', pass: '[đã ẩn]', apiKey: '[đã ẩn]', secret_enc: '[đã ẩn]' });
    expect(out.notify.esms).toEqual({ secretKey: '[đã ẩn]', accessToken: '[đã ẩn]', brandname: 'B' });
    expect(out.list).toEqual([{ token: '[đã ẩn]', ok: 1 }]);
  });
  it('không ẩn khóa rỗng/null (không có gì để lộ)', () => {
    expect(redactSecrets({ token: '', secret: null })).toEqual({ token: '', secret: null });
  });
  it('gom đường dẫn file của ĐÚNG tenant, bỏ đường dẫn lạ hoặc tenant khác', () => {
    const p = `tenants/${T}/id/abc.jpg`;
    const found = collectStoragePaths(T, { front_path: p, photos: [`tenants/${T}/handover/x.png`, 'tenants/22222222-2222-2222-2222-222222222222/a.jpg', `tenants/${T}/../evil`], nested: { logo: `tenants/${T}/brand/l.png` }, note: 'không phải đường dẫn' });
    expect([...found].sort()).toEqual([p, `tenants/${T}/brand/l.png`, `tenants/${T}/handover/x.png`].sort());
  });
  it('Excel: nhiều trang, cột theo hợp khóa, ô bắt đầu bằng = được vô hiệu hóa công thức, jsonb thành chuỗi', async () => {
    const buf = await tablesToXlsx([
      { name: 'Khách hàng', rows: [{ name: '=HYPERLINK("http://x")', phone: '0900', extra: { a: 1 } }, { name: 'B', phone: '0901', n: 5, d: new Date('2027-01-01T00:00:00Z') }] },
      { name: 'Rỗng', rows: [] },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const ws = wb.getWorksheet('Khách hàng')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'name', 'phone', 'extra', 'n', 'd']);
    expect(ws.getRow(2).getCell(1).value).toBe(`'=HYPERLINK("http://x")`);
    expect(ws.getRow(2).getCell(3).value).toBe('{"a":1}');
    expect(ws.getRow(3).getCell(4).value).toBe(5);
    expect(wb.getWorksheet('Rỗng')).toBeDefined();
  });
  it('readme nêu số liệu và cảnh báo cắt bớt', () => {
    const t = exportReadme({ tenantName: 'Shop', slug: 'shop', exportedAt: new Date('2027-01-01T00:00:00Z'), tables: 3, rows: 10, files: 2, missingFiles: 1, truncated: ['audit_log'] });
    expect(t).toContain('3 bảng (10 dòng)');
    expect(t).toContain('1 file có trong dữ liệu nhưng không đọc được');
    expect(t).toContain('audit_log');
  });
});
