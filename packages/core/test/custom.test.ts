import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DOC_TEMPLATES, DomainError, FieldError, LABEL_DEFAULTS, OWNER_ONLY_PERMISSIONS, PERMISSIONS, RoleError, checkDomain, cleanLabels, coerceValue, contractExtras, contrastText,
  formatFieldValue, makeVerifyToken, normalizeDomain, normalizeRole, renderDocText, resolveBranding, resolveLabels, resolveTemplates, sanitizeCustomPermissions, slugifyKey,
  unknownDocVariables, validateCustomValues, validateDocText, validateFieldDef, verifyRecordName, type DnsResolver, type FieldDef,
} from '../src';

const def = (over: Partial<FieldDef> = {}): FieldDef => ({ entity: 'CUSTOMER', key: 'so_khung', label: 'Số khung', kind: 'TEXT', required: false, options: [], showInList: false, searchable: false, inContract: false, sort: 0, active: true, ...over });

describe('định nghĩa trường tùy chỉnh', () => {
  it('tạo mã từ tên tiếng Việt', () => {
    expect(slugifyKey('Số khung máy')).toBe('so_khung_may');
    expect(slugifyKey('  Đăng ký xe!! ')).toBe('dang_ky_xe');
    expect(slugifyKey('2 lần bảo hành')).toBe('f_2_lan_bao_hanh');
  });
  it('kiểm tra định nghĩa', () => {
    expect(validateFieldDef(def())).toBeNull();
    expect(validateFieldDef(def({ key: 'So-Khung' }))).toMatch(/Mã trường/);
    expect(validateFieldDef(def({ key: 'status' }))).toMatch(/trùng tên hệ thống/);
    expect(validateFieldDef(def({ label: ' ' }))).toMatch(/Tên trường/);
    expect(validateFieldDef(def({ label: 'a<b' }))).toMatch(/ký tự </);
    expect(validateFieldDef(def({ kind: 'SELECT', options: ['A'] }))).toMatch(/ít nhất 2 lựa chọn/);
    expect(validateFieldDef(def({ kind: 'SELECT', options: ['A', 'a'] }))).toMatch(/không được trùng/);
    expect(validateFieldDef(def({ kind: 'SELECT', options: ['A', 'B'] }))).toBeNull();
    expect(validateFieldDef(def({ options: ['A', 'B'] }))).toMatch(/Chỉ trường kiểu "Chọn một"/);
    expect(validateFieldDef(def({ kind: 'FILE', inContract: true }))).toMatch(/tệp đính kèm/);
    expect(validateFieldDef(def({ kind: 'DATE', searchable: true }))).toMatch(/tìm kiếm/);
    expect(validateFieldDef(def({ entity: 'UNIT', inContract: true }))).toMatch(/chưa chèn vào hợp đồng/);
  });
});

describe('chuẩn hóa giá trị', () => {
  const c = (kind: FieldDef['kind'], raw: unknown, options: string[] = []) => coerceValue({ label: 'Trường', kind, options }, raw);
  it('trống thành null', () => {
    for (const k of ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN', 'FILE'] as const) expect(c(k, '  ', ['a', 'b'])).toBeNull();
    expect(c('TEXT', undefined)).toBeNull();
  });
  it('văn bản, số (kiểu Việt và kiểu máy), ngày, chọn, có/không', () => {
    expect(c('TEXT', ' abc ')).toBe('abc');
    expect(() => c('TEXT', 'x'.repeat(501))).toThrow(/tối đa 500/);
    expect(c('NUMBER', '1.234,5')).toBe(1234.5);
    expect(c('NUMBER', '1234.5')).toBe(1234.5);
    expect(c('NUMBER', '12,5')).toBe(12.5);
    expect(c('NUMBER', 7)).toBe(7);
    expect(() => c('NUMBER', 'abc')).toThrow(FieldError);
    expect(() => c('NUMBER', 'Infinity')).toThrow(/phải là một số/);
    expect(c('DATE', '2027-02-28')).toBe('2027-02-28');
    expect(() => c('DATE', '2027-02-30')).toThrow(/ngày hợp lệ/);
    expect(() => c('DATE', '28/02/2027')).toThrow(/ngày hợp lệ/);
    expect(c('SELECT', 'Đỏ', ['Đỏ', 'Xanh'])).toBe('Đỏ');
    expect(() => c('SELECT', 'Vàng', ['Đỏ', 'Xanh'])).toThrow(/không nằm trong danh sách/);
    expect([c('BOOLEAN', 'on'), c('BOOLEAN', 'Không'), c('BOOLEAN', true), c('BOOLEAN', '0')]).toEqual([true, false, true, false]);
    expect(() => c('BOOLEAN', 'có thể')).toThrow(/Có hoặc Không/);
  });
  it('tệp đính kèm chỉ nhận đối tượng {path,name} hợp lệ', () => {
    expect(c('FILE', { path: 'tenants/x/f/1.png', name: 'a.png' })).toEqual({ path: 'tenants/x/f/1.png', name: 'a.png' });
    expect(() => c('FILE', 'chuoi-bat-ky')).toThrow(/tệp đính kèm không hợp lệ/);
    expect(() => c('FILE', { path: '', name: 'a' })).toThrow(FieldError);
  });
});

describe('kiểm tra bộ giá trị', () => {
  const defs = [def({ key: 'a', label: 'A', required: true }), def({ key: 'b', label: 'B', kind: 'NUMBER' }), def({ key: 'off', label: 'Tắt', active: false })];
  it('tạo mới: thiếu trường bắt buộc, khóa lạ và trường đã tắt bị từ chối', () => {
    expect(validateCustomValues(defs, {}, true).errors).toEqual(['Vui lòng nhập "A".']);
    expect(validateCustomValues(defs, { a: 'x', b: '5' }, true)).toEqual({ clean: { a: 'x', b: 5 }, errors: [] });
    expect(validateCustomValues(defs, { a: 'x', zzz: 1 }, true).errors).toEqual(['Trường "zzz" không tồn tại hoặc đã bị tắt.']);
    expect(validateCustomValues(defs, { a: 'x', off: 'y' }, true).errors).toHaveLength(1);
    expect(validateCustomValues(defs, { a: 'x', b: 'abc' }, true).errors[0]).toMatch(/"B" phải là một số/);
  });
  it('sửa một phần: không bắt nhập lại trường không gửi, nhưng cấm xóa trắng trường bắt buộc; trống ở trường tùy chọn bị bỏ', () => {
    expect(validateCustomValues(defs, { b: '3' }, false)).toEqual({ clean: { b: 3 }, errors: [] });
    expect(validateCustomValues(defs, { a: '' }, false).errors).toEqual(['Vui lòng nhập "A".']);
    expect(validateCustomValues(defs, { b: '' }, false)).toEqual({ clean: {}, errors: [] });
  });
  it('gom nhiều lỗi một lần', () => {
    expect(validateCustomValues(defs, { b: 'x', q: 1 }, true).errors).toHaveLength(3);
  });
});

describe('hiển thị và chèn vào hợp đồng', () => {
  it('định dạng giá trị', () => {
    expect(formatFieldValue({ kind: 'BOOLEAN' }, true)).toBe('Có');
    expect(formatFieldValue({ kind: 'BOOLEAN' }, false)).toBe('Không');
    expect(formatFieldValue({ kind: 'DATE' }, '2027-03-05')).toBe('05/03/2027');
    expect(formatFieldValue({ kind: 'NUMBER' }, 1234567)).toBe('1.234.567');
    expect(formatFieldValue({ kind: 'FILE' }, { path: 'p', name: 'bien-so.png' })).toBe('bien-so.png');
    expect(formatFieldValue({ kind: 'TEXT' }, null)).toBe('');
  });
  it('chỉ các trường bật "chèn vào hợp đồng", đang hoạt động, có giá trị, theo thứ tự', () => {
    const defs = [def({ key: 'x', label: 'X', inContract: true, sort: 2 }), def({ key: 'y', label: 'Y', inContract: true, sort: 1 }), def({ key: 'z', label: 'Z' }), def({ key: 'w', label: 'W', inContract: true, active: false }), def({ key: 'e', label: 'E', inContract: true })];
    expect(contractExtras(defs, { x: 'vx', y: 'vy', z: 'vz', w: 'vw' })).toEqual([{ label: 'Y', value: 'vy' }, { label: 'X', value: 'vx' }]);
  });
});

describe('nhãn', () => {
  it('ghép nhãn tùy biến lên mặc định, bỏ nhãn sai', () => {
    expect(resolveLabels(undefined)).toEqual(LABEL_DEFAULTS);
    const l = resolveLabels({ unit: 'Sản phẩm', booking: ' Booking ', customer: '<script>', contract: '', bogus: 'x' });
    expect(l.unit).toBe('Sản phẩm');
    expect(l.booking).toBe('Booking');
    expect(l.customer).toBe(LABEL_DEFAULTS.customer);
    expect(l.contract).toBe(LABEL_DEFAULTS.contract);
  });
  it('lưu gọn và báo lỗi tiếng Việt', () => {
    expect(cleanLabels({ unit: 'Sản phẩm', booking: 'Đơn thuê', customer: '  ' })).toEqual({ unit: 'Sản phẩm' });
    expect(() => cleanLabels({ unit: 'x'.repeat(31) })).toThrow(/Thiết bị: Nhãn tối đa 30/);
    expect(() => cleanLabels({ unit: 'a{b}' })).toThrow(/ký tự/);
    expect(() => cleanLabels({ nope: 'x' })).toThrow(/không tồn tại/);
  });
});

describe('mẫu tài liệu', () => {
  it('biến hợp lệ gồm biến hệ thống và trường tùy chỉnh', () => {
    expect(unknownDocVariables('{ten_khach} {cf.so_khung} {cf.khac} {xyz}', ['so_khung'])).toEqual(['cf.khac', 'xyz']);
    expect(validateDocText('Xin chào {ten_khach}')).toBeNull();
    expect(validateDocText('Xin {xyz}')).toMatch(/Biến không hợp lệ: \{xyz\}/);
    expect(validateDocText(' ')).toMatch(/không được để trống/);
    expect(validateDocText('x'.repeat(801))).toMatch(/tối đa 800/);
  });
  it('thay biến, bỏ khoảng trắng thừa', () => {
    expect(renderDocText('Bên B: {ten_khach} , đơn {ma_don}.', { ten_khach: 'An', ma_don: 'DT-1' })).toBe('Bên B: An, đơn DT-1.');
    expect(renderDocText('Số khung {cf.so_khung}.', { 'cf.so_khung': 'ABC123' })).toBe('Số khung ABC123.');
    expect(renderDocText('Còn {tien_coc} đ', {})).toBe('Còn đ');
  });
  it('mẫu hiệu lực: phần thiếu dùng mặc định, dữ liệu hỏng dùng mặc định', () => {
    expect(resolveTemplates(undefined).contract).toEqual({ title: DEFAULT_DOC_TEMPLATES.contract.title, terms: [...DEFAULT_DOC_TEMPLATES.contract.terms] });
    const t = resolveTemplates({ contract: { title: 'HỢP ĐỒNG THUÊ MÁY', terms: ['Điều 1'] }, receipt: { title: 'BIÊN LAI', footer: '' } });
    expect(t.contract).toEqual({ title: 'HỢP ĐỒNG THUÊ MÁY', terms: ['Điều 1'] });
    expect(t.receipt.title).toBe('BIÊN LAI');
    expect(t.handover.title).toBe('BIÊN BẢN GIAO NHẬN THIẾT BỊ');
    expect(resolveTemplates({ contract: { title: '', terms: [] } }).contract.title).toBe(DEFAULT_DOC_TEMPLATES.contract.title);
    expect(resolveTemplates('rác').receipt.footer).toBe(DEFAULT_DOC_TEMPLATES.receipt.footer);
  });
});

describe('thương hiệu', () => {
  it('chữ đọc được trên nền sáng/tối', () => {
    expect(contrastText('#ffffff')).toBe('#000000');
    expect(contrastText('#0f172a')).toBe('#ffffff');
    expect(contrastText('#fde047')).toBe('#000000');
    expect(contrastText('khong-phai-mau')).toBe('#ffffff');
  });
  it('chỉ áp dụng khi gói có white-label; cấu hình hỏng thì về mặc định', () => {
    const raw = { displayName: 'Cửa hàng Sáng', primaryColor: '#e11d48', logoPath: 'tenants/x/brand/a.png', hideProductBrand: true, footerText: 'Hotline 0909' };
    expect(resolveBranding(raw, false)).toMatchObject({ displayName: null, primaryColor: '#0f172a', hasLogo: false, hideProductBrand: false });
    expect(resolveBranding(raw, true)).toMatchObject({ displayName: 'Cửa hàng Sáng', primaryColor: '#e11d48', textOnPrimary: '#ffffff', hasLogo: true, hideProductBrand: true, footerText: 'Hotline 0909' });
    expect(resolveBranding({ primaryColor: 'đỏ' }, true).primaryColor).toBe('#0f172a');
    expect(resolveBranding(null, true).displayName).toBeNull();
  });
});

describe('vai trò tùy chỉnh', () => {
  it('chuẩn hóa: kéo theo quyền xem, sắp theo thứ tự chuẩn', () => {
    const r = normalizeRole({ name: ' Thu ngân ', permissions: ['payment.create', 'deposit.collect', 'booking.view'] });
    expect(r.name).toBe('Thu ngân');
    expect(r.permissions).toEqual(PERMISSIONS.filter((p) => ['payment.create', 'payment.view', 'deposit.collect', 'deposit.view', 'booking.view'].includes(p)));
    expect(r.added.sort()).toEqual(['deposit.view', 'payment.view']);
    expect(normalizeRole({ name: 'A b', permissions: ['customer.anonymize'] }).permissions).toEqual(['customer.view', 'customer.manage', 'customer.anonymize']);
  });
  it('từ chối tên sai, quyền lạ, quyền dành riêng cho chủ, vai trò rỗng', () => {
    expect(() => normalizeRole({ name: 'A', permissions: ['booking.view'] })).toThrow(/Tên vai trò/);
    expect(() => normalizeRole({ name: 'Vai <b>', permissions: ['booking.view'] })).toThrow(RoleError);
    expect(() => normalizeRole({ name: 'Hợp lệ', permissions: ['bay.bong'] })).toThrow(/không tồn tại/);
    for (const p of OWNER_ONLY_PERMISSIONS) expect(() => normalizeRole({ name: 'Hợp lệ', permissions: [p] })).toThrow(/chỉ dành cho chủ cửa hàng/);
    expect(() => normalizeRole({ name: 'Hợp lệ', permissions: [] })).toThrow(/ít nhất một quyền/);
  });
  it('đọc từ DB: bỏ quyền lạ và quyền của chủ', () => {
    expect(sanitizeCustomPermissions(['booking.view', 'billing.manage', 'data.delete', 'bay.bong'])).toEqual(['booking.view']);
  });
});

describe('tên miền riêng', () => {
  it('chuẩn hóa đầu vào', () => {
    expect(normalizeDomain('  HTTPS://Thue-May.vn/trang?x=1 ')).toBe('thue-may.vn');
    expect(normalizeDomain('app.cuahang.com.vn.')).toBe('app.cuahang.com.vn');
    expect(normalizeDomain('xn--thuthit-ks8d.vn')).toBe('xn--thuthit-ks8d.vn');
  });
  it('từ chối tên sai, IP, nội bộ, có cổng, và tên miền của nền tảng', () => {
    for (const bad of ['', 'khongcochamdau', '-a.vn', 'a..vn', 'a b.vn', 'a.v', '192.168.1.1', 'localhost', 'shop.localhost', 'shop.local', 'x.test']) expect(() => normalizeDomain(bad), bad).toThrow(DomainError);
    expect(() => normalizeDomain('shop.vn:8080')).toThrow(/không kèm cổng/);
    expect(() => normalizeDomain('rentpro.vn', 'rentpro.vn')).toThrow(/thuộc rentpro\.vn/);
    expect(() => normalizeDomain('abc.rentpro.vn', 'rentpro.vn')).toThrow(/thuộc rentpro\.vn/);
    expect(normalizeDomain('notrentpro.vn', 'rentpro.vn')).toBe('notrentpro.vn'); // chỉ so khớp đúng ranh giới nhãn
  });
  it('mã xác minh ngẫu nhiên, tên bản ghi TXT', () => {
    expect(makeVerifyToken()).toMatch(/^rentpro-[0-9a-f]{36}$/);
    expect(makeVerifyToken()).not.toBe(makeVerifyToken());
    expect(verifyRecordName('shop.vn')).toBe('_rentpro-verify.shop.vn');
  });
  const dns = (txt: string[][] | Error, cname: string[] | Error): DnsResolver => ({
    resolveTxt: async () => { if (txt instanceof Error) throw txt; return txt; },
    resolveCname: async () => { if (cname instanceof Error) throw cname; return cname; },
  });
  it('xác minh qua TXT; CNAME chỉ cảnh báo', async () => {
    const ok = await checkDomain('shop.vn', 'rentpro-abc', 'custom.rentpro.vn', dns([['rentpro-', 'abc']], ['custom.rentpro.vn.']));
    expect(ok).toMatchObject({ ok: true, txtOk: true, cnameOk: true, message: 'Đã xác minh tên miền.' });
    const warn = await checkDomain('shop.vn', 'rentpro-abc', 'custom.rentpro.vn', dns([['rentpro-abc']], new Error('ENODATA')));
    expect(warn).toMatchObject({ ok: true, cnameOk: false });
    expect(warn.message).toMatch(/chưa trỏ CNAME/);
    const wrong = await checkDomain('shop.vn', 'rentpro-abc', null, dns([['rentpro-khac']], []));
    expect(wrong).toMatchObject({ ok: false, txtOk: false, cnameOk: null });
    expect(wrong.message).toMatch(/Chưa thấy bản ghi TXT _rentpro-verify\.shop\.vn/);
    expect((await checkDomain('shop.vn', 't', null, dns(new Error('ENOTFOUND'), []))).ok).toBe(false);
  });
});
