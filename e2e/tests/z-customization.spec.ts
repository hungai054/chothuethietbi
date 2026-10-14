import { test, expect, type Browser, type Page } from '@playwright/test';
import { createPool, setFeatureOverrides } from '@rentpro/db';
import { E2E_PASSWORD } from '../global-setup';
import { pageFetch } from './helpers';

// Chạy SAU các bộ khác (tên bắt đầu bằng z): bộ này đổi cấu hình dùng chung của tenant (trường bắt buộc, nhãn, thương hiệu).
test.use({ baseURL: process.env.E2E_TENANT_URL });
test.describe.configure({ mode: 'serial' });

const SUFFIX = String(Date.now()).slice(-5);
const PLATE = `51A-${SUFFIX}`;
const DAY = 10 + (Number(SUFFIX) % 15);
const START = `2029-03-${DAY}T08:00`;
const END = `2029-03-${DAY + 1}T08:00`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 9)]);
const PASSWORD = 'Mat-khau-12345';
const actor = { id: '00000000-0000-0000-0000-000000000000', email: 'e2e@rentpro.local' };

const sql = async (q: string, args: unknown[] = []) => {
  const p = createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');
  try { return (await p.query(q, args)).rows; } finally { await p.end(); }
};

async function login(page: Page, email: string, password = E2E_PASSWORD) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Mật khẩu').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}
const owner = (page: Page) => login(page, 'owner@e2e.local');

test.beforeAll(async () => {
  // Tenant E2E ở gói Chuyên nghiệp; bật thêm các tính năng gói Doanh nghiệp bằng ghi đè theo tenant (đúng cách cổng quản trị làm)
  const pool = createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');
  await setFeatureOverrides(pool, actor, process.env.E2E_TENANT_ID!, { white_label: true, custom_roles: true, custom_domain: true });
  await pool.end();
});

test('trung tâm cài đặt liệt kê đủ mục; mục theo gói hiện đúng', async ({ page }) => {
  await owner(page);
  await page.getByRole('link', { name: 'Cài đặt' }).click();
  const hub = page.getByTestId('settings-hub');
  for (const t of ['Tài chính và hợp đồng', 'Mẫu tài liệu', 'Nhãn và thuật ngữ', 'Trường tùy chỉnh', 'Thương hiệu (white-label)', 'Người dùng', 'Vai trò tùy chỉnh', 'Tên miền riêng']) await expect(hub).toContainText(t);
  await expect(hub).not.toContainText('Cần nâng cấp gói');
});

test('trường tùy chỉnh: tạo trường bắt buộc/tìm kiếm/hiện danh sách; tạo khách thiếu giá trị bị chặn; có giá trị thì hiện cột và tìm được', async ({ page }) => {
  await owner(page);
  await page.goto('/settings/custom-fields');
  const form = page.getByTestId('field-form');
  const add = async (entity: string, label: string, flags: string[], kind = 'TEXT') => {
    await page.goto('/settings/custom-fields'); // trang mới hoàn toàn: tránh trạng thái ô nhập còn sót sau chuyển trang mềm
    await form.locator('select[name=entity]').selectOption(entity);
    await form.locator('input[name=label]').fill(label);
    await form.locator('select[name=kind]').selectOption(kind);
    // Next giữ nguyên trạng thái ô nhập sau khi chuyển trang mềm nên phải bỏ chọn trước
    for (const f of ['required', 'showInList', 'searchable', 'inContract']) await form.locator(`input[name=${f}]`).setChecked(flags.includes(f));
    await form.getByRole('button', { name: 'Thêm trường' }).click();
    await expect(page.getByText('Đã thêm trường tùy chỉnh.')).toBeVisible();
  };
  await add('CUSTOMER', 'Biển số xe', ['required', 'showInList', 'searchable', 'inContract']);
  await add('CUSTOMER', 'Ảnh bằng lái', [], 'FILE');
  await add('BOOKING', 'Địa điểm sử dụng', ['required', 'searchable', 'inContract']);
  await add('CONTRACT', 'Người bảo lãnh', ['required', 'inContract']);
  await add('UNIT', 'Vị trí kệ', ['showInList', 'searchable']);
  // mã trùng bị từ chối bằng tiếng Việt
  await page.goto('/settings/custom-fields');
  await form.locator('select[name=entity]').selectOption('CUSTOMER');
  await form.locator('input[name=label]').fill('Biển số xe');
  await form.getByRole('button', { name: 'Thêm trường' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('đã tồn tại ở khách hàng');

  await page.goto('/customers/new');
  await page.locator('input[name=name]').fill('Khách Tùy Chỉnh');
  await page.locator('input[name=phone]').fill(`09${SUFFIX}123`.slice(0, 10));
  await page.getByRole('button', { name: 'Tạo khách hàng' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Vui lòng nhập "Biển số xe"');
  expect(await sql("SELECT 1 FROM customer WHERE tenant_id=$1 AND name='Khách Tùy Chỉnh'", [process.env.E2E_TENANT_ID])).toHaveLength(0);
  await page.locator('input[name=name]').fill('Khách Tùy Chỉnh');
  await page.locator('input[name=phone]').fill(`09${SUFFIX}123`.slice(0, 10));
  await page.locator('input[name=cf_bien_so_xe]').fill(PLATE);
  await page.getByRole('button', { name: 'Tạo khách hàng' }).click();
  await expect(page.getByText('Đã tạo khách hàng.')).toBeVisible();
  await expect(page.getByTestId('custom-fields-panel')).toBeVisible();
  await expect(page.locator('input[name=cf_bien_so_xe]').last()).toHaveValue(PLATE);

  // đính kèm tệp ảnh vào trường tệp
  await page.getByTestId('custom-fields-panel').locator('input[name=cffile_anh_bang_lai]').setInputFiles({ name: 'bang-lai.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: 'Lưu trường tùy chỉnh' }).click();
  await expect(page.getByText('Đã lưu trường tùy chỉnh.')).toBeVisible();
  const link = page.getByTestId('custom-fields-panel').getByRole('link', { name: 'bang-lai.png' });
  await expect(link).toBeVisible();
  const r = await pageFetch(page, (await link.getAttribute('href'))!);
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toBe('image/png');
  // định dạng không phải ảnh bị từ chối
  await page.getByTestId('custom-fields-panel').locator('input[name=cffile_anh_bang_lai]').setInputFiles({ name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('khong phai anh') });
  await page.getByRole('button', { name: 'Lưu trường tùy chỉnh' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('JPG, PNG');

  await page.goto(`/customers?q=${encodeURIComponent(PLATE)}`);
  const row = page.locator('tbody tr', { hasText: 'Khách Tùy Chỉnh' });
  await expect(row).toHaveCount(1);
  await expect(page.locator('thead')).toContainText('Biển số xe');
  await expect(row).toContainText(PLATE);
  await page.goto('/customers?q=khong-co-bien-so-nay');
  await expect(page.locator('tbody tr', { hasText: 'Khách Tùy Chỉnh' })).toHaveCount(0);
});

test('trường của thiết bị: sửa ở trang chi tiết, hiện cột và tìm được trong danh sách', async ({ page }) => {
  await owner(page);
  await page.goto('/inventory');
  await page.getByRole('link', { name: 'CAM-000002' }).click();
  await page.locator('input[name=cf_vi_tri_ke]').fill(`Kệ-${SUFFIX}`);
  await page.getByRole('button', { name: 'Lưu trường tùy chỉnh' }).click();
  await expect(page.getByText('Đã lưu trường tùy chỉnh.')).toBeVisible();
  await page.goto(`/inventory?q=${encodeURIComponent(`Kệ-${SUFFIX}`)}`);
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('CAM-000002');
  await expect(page.locator('thead')).toContainText('Vị trí kệ');
  const x = await pageFetch(page, '/inventory/export');
  expect(x.status).toBe(200);
  expect(x.bytes.slice(0, 2)).toEqual([0x50, 0x4b]);
});

let contractBookingId = '';

test('mẫu hợp đồng: biến lạ bị từ chối; xem trước bản nháp; lưu mẫu có biến và trường tùy chỉnh', async ({ page }) => {
  await owner(page);
  await page.goto('/settings/templates');
  await expect(page.getByTestId('template-vars')).toContainText('{cf.bien_so_xe}');
  const form = page.getByTestId('contract-template');
  await form.locator('textarea[name=terms]').fill('Điều 1: {xyz}');
  await form.getByRole('button', { name: 'Xem trước bản đang soạn' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Biến không hợp lệ');
  await form.locator('textarea[name=terms]').fill('Bên B {ten_khach} (biển số {cf.bien_so_xe}) bảo lãnh bởi {cf.nguoi_bao_lanh}.\nThanh toán theo đơn {ma_don}, tổng {tong_tien}.');
  await form.locator('input[name=title]').fill('HỢP ĐỒNG THUÊ MÁY ẢNH E2E');
  await form.getByRole('button', { name: 'Xem trước bản đang soạn' }).click();
  const pv = page.getByTestId('contract-preview');
  await expect(pv).toContainText('HỢP ĐỒNG THUÊ MÁY ẢNH E2E');
  await expect(pv).toContainText('Bên B Nguyễn Văn A (biển số ) bảo lãnh bởi.'); // dữ liệu mẫu chưa có trường tùy chỉnh
  expect(await sql("SELECT settings->'templates' t FROM tenant WHERE id=$1", [process.env.E2E_TENANT_ID]).then((r) => r[0].t)).toBeNull(); // xem trước không lưu
  await page.getByTestId('contract-template').locator('textarea[name=terms]').fill('Bên B {ten_khach} (biển số {cf.bien_so_xe}) bảo lãnh bởi {cf.nguoi_bao_lanh}.\nThanh toán theo đơn {ma_don}, tổng {tong_tien}.');
  await page.getByTestId('contract-template').locator('input[name=title]').fill('HỢP ĐỒNG THUÊ MÁY ẢNH E2E');
  await page.getByTestId('contract-template').getByRole('button', { name: 'Lưu mẫu hợp đồng' }).click();
  await expect(page.getByText(/Đã lưu mẫu hợp đồng/)).toBeVisible();
  await expect(page.getByTestId('contract-template')).toContainText('đã tùy chỉnh');
});

test('luồng đầy đủ: đơn thuê có trường bắt buộc → hợp đồng theo mẫu mới với trường tùy chỉnh và biến được thay', async ({ page }) => {
  await owner(page);
  await page.goto('/bookings/new');
  const cust = await page.locator('select[name=customer] option', { hasText: 'Khách Tùy Chỉnh' }).getAttribute('value');
  await page.locator('select[name=customer]').selectOption(cust!);
  await page.getByLabel('Nhận thiết bị', { exact: false }).fill(START);
  await page.getByLabel('Trả thiết bị').fill(END);
  const m = await page.locator('select[name=m1] option', { hasText: 'Sony A7 E2E' }).getAttribute('value');
  await page.locator('select[name=m1]').selectOption(m!);
  await page.locator('input[name=q1]').fill('1');
  await page.locator('input[name=cf_dia_diem_su_dung]').fill('Resort Đà Lạt');
  await page.getByRole('button', { name: 'Tính giá & kiểm tra lịch' }).click();
  await expect(page.getByTestId('booking-preview')).toBeVisible();
  await page.getByRole('button', { name: 'Xác nhận đơn' }).click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}/);
  contractBookingId = page.url().split('?')[0]!.split('/').pop()!;
  await expect(page.getByTestId('custom-fields-panel').locator('input[name=cf_dia_diem_su_dung]')).toHaveValue('Resort Đà Lạt');

  // hợp đồng: trường bắt buộc của hợp đồng
  await page.getByRole('button', { name: 'Lập hợp đồng' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Vui lòng nhập "Người bảo lãnh"');
  await page.getByTestId('contract-section').locator('input[name=cf_nguoi_bao_lanh]').fill('Lê Văn Bảo');
  await page.getByRole('button', { name: 'Lập hợp đồng' }).click();
  await expect(page.getByTestId('contract-number')).toHaveText(/^HD-/);
  await page.goto(`/bookings/${contractBookingId}/contract`);
  const doc = page.getByTestId('contract-print');
  await expect(doc).toContainText('HỢP ĐỒNG THUÊ MÁY ẢNH E2E');
  await expect(doc).toContainText(`Bên B Khách Tùy Chỉnh (biển số ${PLATE}) bảo lãnh bởi Lê Văn Bảo.`);
  await expect(doc).not.toContainText('{');
  await expect(page.getByTestId('contract-extras')).toContainText('Địa điểm sử dụng: Resort Đà Lạt');
  await expect(page.getByTestId('contract-extras')).toContainText('Người bảo lãnh: Lê Văn Bảo');
  // tìm đơn theo trường tùy chỉnh
  await page.goto('/bookings?q=Resort');
  await expect(page.locator('tbody tr')).toHaveCount(1);
});

test('phiếu thu theo mẫu của cửa hàng', async ({ page }) => {
  await owner(page);
  await page.goto('/settings/templates');
  const f = page.getByTestId('receipt-template');
  await f.locator('input[name=title]').fill('BIÊN LAI THU TIỀN E2E');
  await f.locator('input[name=footer]').fill('Hotline 0909 000 111');
  await f.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByText('Đã lưu mẫu phiếu thu.')).toBeVisible();
  await page.goto(`/bookings/${contractBookingId}`);
  const form = page.getByTestId('payment-form');
  await form.locator('select[name=kind]').selectOption('RENT');
  await form.locator('input[name=amount]').fill('123456');
  await form.getByRole('button', { name: 'Ghi khoản' }).click();
  await expect(page.getByText('Đã ghi khoản thanh toán.')).toBeVisible();
  await page.getByRole('link', { name: 'In phiếu' }).first().click();
  const rc = page.getByTestId('receipt');
  await expect(rc).toContainText('BIÊN LAI THU TIỀN E2E');
  await expect(rc).toContainText('123.456 đ');
  await expect(rc).toContainText('Một trăm hai mươi ba nghìn bốn trăm năm mươi sáu đồng');
  await expect(rc).toContainText('Khách Tùy Chỉnh');
  await expect(rc).toContainText('Hotline 0909 000 111');
});

test('nhãn và thuật ngữ: đổi tên gọi ở menu và tiêu đề; xóa nhãn thì về mặc định', async ({ page }) => {
  await owner(page);
  await page.goto('/settings/labels');
  await page.getByLabel('Nhãn Thiết bị', { exact: true }).fill('Sản phẩm');
  await page.getByLabel('Nhãn Đơn thuê').fill('Booking');
  await page.getByRole('button', { name: 'Lưu nhãn' }).click();
  await expect(page.getByText('Đã lưu nhãn.')).toBeVisible();
  const nav = page.getByTestId('app-header');
  await expect(nav.getByRole('link', { name: 'Sản phẩm', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Booking', exact: true })).toBeVisible();
  await page.goto('/inventory');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Sản phẩm');
  await page.goto('/settings/labels');
  await page.getByLabel('Nhãn Thiết bị', { exact: true }).fill('Sản {phẩm}'); // ô nhập đã giới hạn 30 ký tự nên thử ký tự không hợp lệ
  await page.getByRole('button', { name: 'Lưu nhãn' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('không được chứa ký tự');
  await page.getByLabel('Nhãn Thiết bị', { exact: true }).fill('');
  await page.getByLabel('Nhãn Đơn thuê').fill('');
  await page.getByRole('button', { name: 'Lưu nhãn' }).click();
  await expect(page.getByTestId('app-header').getByRole('link', { name: 'Đơn thuê', exact: true })).toBeVisible();
});

test('thương hiệu: logo, tên hiển thị, màu, chân trang, ẩn thương hiệu sản phẩm; trang đăng nhập và favicon theo cửa hàng', async ({ page, browser }) => {
  await owner(page);
  await page.goto('/settings/branding');
  const f = page.getByTestId('branding-form');
  await f.locator('input[name=displayName]').fill('Cửa hàng Sáng E2E');
  await f.locator('input[name=primaryColor]').fill('#e11d48');
  await f.locator('input[name=footerText]').fill('Hotline 0909 000 111 · 1 Lê Lợi');
  await f.locator('input[name=logo]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await f.locator('input[name=favicon]').setInputFiles({ name: 'fav.png', mimeType: 'image/png', buffer: PNG });
  await f.locator('input[name=hideProductBrand]').check();
  await f.getByRole('button', { name: 'Lưu thương hiệu' }).click();
  await expect(page.getByText('Đã lưu thương hiệu.')).toBeVisible();
  const header = page.getByTestId('app-header');
  await expect(page.getByTestId('shop-name')).toHaveText('Cửa hàng Sáng E2E');
  await expect(header.getByAltText(/Logo/)).toBeVisible();
  expect(await header.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(225, 29, 72)');
  await expect(page.getByTestId('app-footer')).toContainText('Hotline 0909 000 111');
  await expect(page.getByTestId('app-footer')).not.toContainText('RentPro');
  await expect(page).toHaveTitle('Cửa hàng Sáng E2E');
  // chữ trên nền đậm vẫn đọc được (trắng)
  expect(await header.evaluate((e) => getComputedStyle(e).color)).toBe('rgb(255, 255, 255)');

  // khách chưa đăng nhập thấy trang đăng nhập mang thương hiệu, logo tải được
  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await gp.goto(`${process.env.E2E_TENANT_URL}/login`);
  await expect(gp.getByTestId('login-title')).toHaveText('Cửa hàng Sáng E2E');
  await expect(gp.getByAltText(/Logo/)).toBeVisible();
  await expect(gp.getByText('Cung cấp bởi RentPro')).toHaveCount(0);
  const logo = await pageFetch(gp, '/brand/logo');
  expect(logo.status).toBe(200);
  expect(logo.headers['content-type']).toBe('image/png');
  expect((await pageFetch(gp, '/brand/khac')).status).toBe(404);
  await guest.close();

  // ảnh sai định dạng bị từ chối, không đổi logo cũ
  await f.locator('input[name=logo]').setInputFiles({ name: 'x.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a-khong-hop-le') });
  await f.getByRole('button', { name: 'Lưu thương hiệu' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('JPG, PNG hoặc WebP');
  expect((await pageFetch(page, '/brand/logo')).status).toBe(200);

  // trở về mặc định
  await page.goto('/settings/branding');
  await f.locator('input[name=displayName]').fill('');
  await f.locator('input[name=footerText]').fill('');
  await f.locator('input[name=hideProductBrand]').uncheck();
  await f.locator('input[name=removeLogo]').check();
  await f.locator('input[name=removeFavicon]').check();
  await f.locator('input[name=primaryColor]').fill('#0f172a');
  await f.getByRole('button', { name: 'Lưu thương hiệu' }).click();
  await expect(page.getByText('Đã lưu thương hiệu.')).toBeVisible();
  await expect(page.getByTestId('app-footer')).toContainText('Cung cấp bởi RentPro');
  expect((await pageFetch(page, `/brand/logo?v=${Date.now()}`)).status).toBe(404); // thêm tham số để vượt bộ nhớ đệm trình duyệt (logo được cache công khai 5 phút)
});

test('vai trò tùy chỉnh và người dùng: tạo vai trò chỉ xem đơn, tạo người dùng, họ chỉ thấy đúng mục; khóa tài khoản có hiệu lực ngay', async ({ page, browser }) => {
  await owner(page);
  await page.goto('/settings/roles');
  const rf = page.getByTestId('role-form');
  await rf.locator('input[name=name]').fill('Chỉ xem đơn E2E');
  await rf.getByRole('button', { name: 'Tạo vai trò' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('ít nhất một quyền');
  await rf.locator('input[name=name]').fill('Chỉ xem đơn E2E');
  await rf.locator('input[name="p:booking.cancel"]').check(); // kéo theo quyền xem đơn
  await rf.getByRole('button', { name: 'Tạo vai trò' }).click();
  await expect(page.getByText(/Đã tạo vai trò\. Đã tự thêm quyền xem đi kèm: Xem đơn thuê/)).toBeVisible();
  await expect(page.locator('[data-testid=role-card] input[name="p:booking.view"]').first()).toBeChecked();
  await expect(page.locator('input[name="p:billing.manage"]')).toHaveCount(0); // quyền dành riêng cho chủ không có trong ma trận

  await page.goto('/settings/users');
  const uf = page.getByTestId('user-form');
  await uf.locator('input[name=email]').fill('thungan@e2e.local');
  await uf.locator('input[name=name]').fill('Thu ngân E2E');
  await uf.locator('input[name=password]').fill('yeu');
  await uf.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('ít nhất 10 ký tự');
  await uf.locator('input[name=email]').fill('thungan@e2e.local');
  await uf.locator('input[name=name]').fill('Thu ngân E2E');
  await uf.locator('input[name=password]').fill(PASSWORD);
  await uf.locator('select[name=customRoleId]').selectOption({ label: 'Chỉ xem đơn E2E' });
  await uf.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(page.getByText('Đã tạo tài khoản.')).toBeVisible();
  await uf.locator('input[name=email]').fill('THUNGAN@e2e.local');
  await uf.locator('input[name=name]').fill('Trùng email');
  await uf.locator('input[name=password]').fill(PASSWORD);
  await uf.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('đã có tài khoản');

  // người dùng mới đăng nhập ở một ngữ cảnh riêng
  const ctx = await browser.newContext();
  const up = await ctx.newPage();
  await up.goto(`${process.env.E2E_TENANT_URL}/login`);
  await up.getByPlaceholder('Email').fill('thungan@e2e.local');
  await up.getByPlaceholder('Mật khẩu').fill(PASSWORD);
  await up.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(up.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
  const nav = up.getByTestId('app-header');
  await expect(nav.getByRole('link', { name: 'Đơn thuê', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Khách hàng', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Cài đặt' })).toHaveCount(0);
  await up.goto(`${process.env.E2E_TENANT_URL}/customers`);
  await expect(up.getByText('Bạn không có quyền truy cập mục này.')).toBeVisible();
  await up.goto(`${process.env.E2E_TENANT_URL}/bookings/new`);
  await expect(up.getByText('Bạn không có quyền truy cập mục này.')).toBeVisible(); // chỉ có quyền hủy/xem, không tạo

  // chủ khóa tài khoản: phiên đang mở mất hiệu lực ngay ở lần tải kế tiếp
  await page.goto('/settings/users');
  const row = page.locator('[data-testid=user-list] > div', { hasText: 'thungan@e2e.local' });
  await row.locator('input[name=active]').uncheck();
  await row.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByText('Đã lưu người dùng.')).toBeVisible();
  await up.goto(`${process.env.E2E_TENANT_URL}/bookings`);
  await expect(up).toHaveURL(/\/login/);
  await ctx.close();

  // chủ không tự khóa mình được
  const me = page.locator('[data-testid=user-list] > div', { hasText: 'owner@e2e.local' });
  await me.locator('input[name=active]').uncheck();
  await me.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.locator('p[role=alert]')).toContainText('tự khóa');
});

test('tên miền riêng: thêm, hướng dẫn DNS, chưa có bản ghi thì chưa xác minh, tên sai bị từ chối, gỡ được; endpoint cấp chứng chỉ chỉ nhận tên miền đã xác minh', async ({ page }) => {
  await owner(page);
  await page.goto('/settings/domains');
  const f = page.getByTestId('domain-form');
  await f.locator('input[name=domain]').fill('192.168.1.1');
  await f.getByRole('button', { name: 'Thêm tên miền' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('địa chỉ IP');
  await f.locator('input[name=domain]').fill('https://Cua-Hang-E2E.vn/trang-chu');
  await f.getByRole('button', { name: 'Thêm tên miền' }).click();
  await expect(page.getByText(/Đã thêm tên miền/)).toBeVisible();
  const item = page.getByTestId('domain-list').locator('li', { hasText: 'cua-hang-e2e.vn' });
  await expect(item.getByTestId('dns-records')).toContainText('_rentpro-verify.cua-hang-e2e.vn');
  await expect(item.getByTestId('dns-records')).toContainText('rentpro-');
  await item.getByRole('button', { name: 'Kiểm tra' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Chưa thấy bản ghi TXT');
  expect((await pageFetch(page, '/api/domain-check?domain=cua-hang-e2e.vn')).status).toBe(404);
  // giả lập xác minh thành công (đã kiểm tra bằng test dịch vụ với DNS giả): endpoint trả 200 và tên miền trỏ về đúng cửa hàng
  await sql("UPDATE tenant_domain SET verified=true, verified_at=now() WHERE tenant_id=$1 AND domain='cua-hang-e2e.vn'", [process.env.E2E_TENANT_ID]);
  expect((await pageFetch(page, '/api/domain-check?domain=cua-hang-e2e.vn')).status).toBe(200);
  expect((await pageFetch(page, '/api/domain-check?domain=khong-co.vn')).status).toBe(404);
  await page.goto('/settings/domains');
  await expect(page.getByTestId('domain-list')).toContainText('Đã xác minh');
  await page.getByTestId('domain-list').getByRole('button', { name: 'Gỡ tên miền' }).click();
  await expect(page.getByText('Đã gỡ tên miền.')).toBeVisible();
});

test('gói không có tính năng: mục bị khóa trong trung tâm cài đặt và trang trả về thông báo rõ', async ({ page }) => {
  const base = process.env.E2E_BASIC_URL!;
  await page.context().clearCookies();
  await page.goto(`${base}/login`);
  await page.getByPlaceholder('Email').fill('owner@e2e-basic.local');
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
  await page.goto(`${base}/settings`);
  await expect(page.getByTestId('settings-hub').locator('li', { hasText: 'Thương hiệu' })).toContainText('Cần nâng cấp gói');
  await expect(page.getByTestId('settings-hub').locator('li', { hasText: 'Trường tùy chỉnh' })).toContainText('Cần nâng cấp gói');
  for (const path of ['settings/branding', 'settings/roles', 'settings/domains', 'settings/custom-fields']) {
    await page.goto(`${base}/${path}`);
    await expect(page.getByText('Gói hiện tại chưa có tính năng này.')).toBeVisible();
  }
  expect((await pageFetch(page, `${base}/brand/logo`)).status).toBe(404); // không có white-label thì không phục vụ ảnh thương hiệu
});

test.afterAll(async () => {
  // dọn cấu hình dùng chung để không ảnh hưởng lần chạy sau trên cùng DB dev
  await sql("UPDATE custom_field_def SET active=false WHERE tenant_id=$1", [process.env.E2E_TENANT_ID]);
  await sql("UPDATE tenant SET settings = settings - 'templates' - 'labels' - 'branding' WHERE id=$1", [process.env.E2E_TENANT_ID]);
});

void (null as unknown as Browser);
