import { test, expect, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

test.use({ baseURL: process.env.E2E_TENANT_URL });
test.describe.configure({ mode: 'serial' });

const SUFFIX = String(Date.now()).slice(-6);
const MODEL = `Máy test ${SUFFIX}`;
const PHONE = `09${SUFFIX}01`; // 8 số sau 09
// PNG 1x1 hợp lệ
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function login(page: Page, role: 'owner' | 'staff' | 'technician' | 'manager') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(`${role}@e2e.local`);
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

test('tạo khách hàng: chuẩn hóa SĐT, báo lỗi tiếng Việt, chặn trùng SĐT', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/customers/new');
  await page.getByLabel('Họ tên (*)').fill('Nguyễn Văn Test');
  await page.getByLabel('Số điện thoại (*)').fill('12345');
  await page.getByRole('button', { name: 'Tạo khách hàng' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Số điện thoại không hợp lệ');

  await page.getByLabel('Họ tên (*)').fill('Nguyễn Văn Test');
  await page.getByLabel('Số điện thoại (*)').fill(`+84 ${PHONE.slice(1, 4)} ${PHONE.slice(4)}`);
  await page.getByRole('button', { name: 'Tạo khách hàng' }).click();
  await expect(page.getByText('Đã tạo khách hàng.')).toBeVisible();
  await expect(page.getByText(PHONE).first()).toBeVisible(); // đã chuẩn hóa về 0xxxxxxxxx

  await page.goto('/customers/new');
  await page.getByLabel('Họ tên (*)').fill('Người khác');
  await page.getByLabel('Số điện thoại (*)').fill(PHONE);
  await page.getByRole('button', { name: 'Tạo khách hàng' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('đã thuộc về một khách');

  await page.goto(`/customers?q=${PHONE.slice(0, 7)}`);
  await expect(page.getByRole('link', { name: 'Nguyễn Văn Test' })).toBeVisible();
});

test('giấy tờ tùy thân: cần đồng ý, lưu mã hóa, chủ xem được số và ảnh qua URL ký', async ({ page }) => {
  await login(page, 'owner');
  await page.goto(`/customers?q=${PHONE}`);
  await page.getByRole('link', { name: 'Nguyễn Văn Test' }).click();

  const form = page.locator('form', { hasText: 'Thêm giấy tờ' });
  await form.getByLabel('Số giấy tờ (*)').fill('001099123456');
  await form.getByRole('button', { name: 'Lưu giấy tờ' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Nghị định 13');

  await form.getByLabel('Số giấy tờ (*)').fill('001099123456');
  await form.getByLabel('Ảnh mặt trước').setInputFiles({ name: 'cccd.png', mimeType: 'image/png', buffer: PNG });
  await form.getByLabel(/Khách đã đồng ý/).check();
  await form.getByRole('button', { name: 'Lưu giấy tờ' }).click();
  await expect(page.getByText('Đã lưu giấy tờ.')).toBeVisible();

  const row = page.locator('li', { hasText: 'CCCD' });
  await expect(row.getByTestId('id-number')).toHaveText('••••3456');
  await expect(page.locator('body')).not.toContainText('001099123456');
  await row.getByRole('button', { name: 'Xem số đầy đủ' }).click();
  await expect(row.getByTestId('id-number')).toHaveText('001099123456');

  const href = await row.getByRole('link', { name: 'Ảnh mặt trước' }).getAttribute('href');
  expect(href).toMatch(/^\/files\/[\w.-]+$/);
  const img = await page.request.get(href!);
  expect(img.status()).toBe(200);
  expect(img.headers()['content-type']).toBe('image/png');
  expect(img.headers()['cache-control']).toContain('no-store');
  expect(img.headers()['x-content-type-options']).toBe('nosniff');
  expect([...(await img.body())]).toEqual([...PNG]);

  // sai chữ ký / hết hạn / không đăng nhập
  expect((await page.request.get('/files/khong-phai-token')).status()).toBe(403);
  expect((await page.request.get(href!.slice(0, -3) + 'abc')).status()).toBe(403);
  const anon = await page.context().browser()!.newContext({ baseURL: process.env.E2E_TENANT_URL });
  expect((await anon.request.get(href!)).status()).toBe(403);
  await anon.close();
});

test('giấy tờ: file không phải ảnh bị từ chối', async ({ page }) => {
  await login(page, 'owner');
  await page.goto(`/customers?q=${PHONE}`);
  await page.getByRole('link', { name: 'Nguyễn Văn Test' }).click();
  const form = page.locator('form', { hasText: 'Thêm giấy tờ' });
  await form.getByLabel('Loại').selectOption('DRIVER_LICENSE');
  await form.getByLabel('Số giấy tờ (*)').fill('123456789012');
  await form.getByLabel('Ảnh mặt trước').setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('<html>không phải ảnh</html>') });
  await form.getByLabel(/Khách đã đồng ý/).check();
  await form.getByRole('button', { name: 'Lưu giấy tờ' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('JPG, PNG hoặc WebP');
});

test('nhân viên quầy thêm được giấy tờ nhưng không xem được số và ảnh; kỹ thuật viên không vào được khách hàng', async ({ page }) => {
  await login(page, 'staff');
  await page.goto(`/customers?q=${PHONE}`);
  await page.getByRole('link', { name: 'Nguyễn Văn Test' }).click();
  const row = page.locator('li', { hasText: 'CCCD' });
  await expect(row.getByTestId('id-number')).toHaveText('••••3456');
  await expect(row.getByRole('button', { name: 'Xem số đầy đủ' })).toHaveCount(0);
  await expect(row.getByRole('link', { name: /Ảnh mặt/ })).toHaveCount(0);
  await expect(page.getByText('Bạn không có quyền xem số và ảnh giấy tờ.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ẩn danh khách hàng này' })).toHaveCount(0);

  await login(page, 'technician');
  await expect(page.getByRole('link', { name: 'Khách hàng' })).toHaveCount(0);
  await page.goto('/customers');
  await expect(page).toHaveURL(/\/\?error=/);
  await expect(page.locator('p[role=alert]')).toContainText('Bạn không có quyền truy cập mục này.');
});

test('bảng giá: nhập giá cho mẫu và báo giá chọn tổ hợp rẻ nhất (25 giờ = 1 ngày + 1 giờ)', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/inventory/models');
  const f = page.locator('form', { hasText: 'Thêm mẫu' });
  await f.getByLabel('Tên mẫu (*)').fill(MODEL);
  await page.getByRole('button', { name: 'Tạo mẫu' }).click();
  await expect(page.getByText('Đã tạo mẫu thiết bị.')).toBeVisible();

  await page.goto('/pricing');
  await expect(page.getByRole('row', { name: new RegExp(MODEL) }).getByText('chưa có giá')).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(MODEL) });
  await row.getByLabel(`Giá giờ ${MODEL}`).fill('100000');
  await row.getByLabel(`Giá ngày ${MODEL}`).fill('500.000');
  await row.getByLabel(`Giá tuần ${MODEL}`).fill('2500000');
  await row.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu giá.')).toBeVisible();
  await expect(page.getByLabel(`Giá ngày ${MODEL}`)).toHaveValue('500000');

  // giá âm bị từ chối
  await page.getByLabel(`Giá ngày ${MODEL}`).fill('-5');
  await page.getByRole('row', { name: new RegExp(MODEL) }).getByRole('button', { name: 'Lưu' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('số nguyên không âm');

  const q = (model: string, start: string, end: string, extra = '') => `/pricing/quote?model=${model}&qty=1&start=${start}&end=${end}${extra}`;
  const modelId = await (async () => {
    await page.goto('/pricing/quote');
    return page.locator('select[name=model] option', { hasText: MODEL }).getAttribute('value');
  })();
  await page.goto(q(modelId!, '2026-11-02T08:00', '2026-11-03T09:00'));
  await expect(page.getByTestId('quote-total')).toHaveText(/600\.000\s*đ/);
  await expect(page.getByText('1 ngày × 500.000 đ + 1 giờ × 100.000 đ')).toBeVisible();
  await page.goto(q(modelId!, '2026-11-02T08:00', '2026-11-11T08:00')); // 9 ngày = 1 tuần + 2 ngày
  await expect(page.getByTestId('quote-total')).toHaveText(/3\.500\.000\s*đ/);
  await expect(page.getByText('1 tuần × 2.500.000 đ + 2 ngày × 500.000 đ')).toBeVisible();
  await page.goto(q(modelId!, '2026-11-02T08:00', '2026-11-02T08:00'));
  await expect(page.locator('p[role=alert]')).toContainText('sau thời gian bắt đầu');
});

test('nhóm khách giảm giá và quy tắc VAT áp dụng vào báo giá', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/customers/groups');
  await page.getByLabel('Tên nhóm').fill(`Đối tác ${SUFFIX}`);
  await page.getByLabel('Giảm giá (%)').fill('10');
  await page.getByRole('button', { name: 'Thêm nhóm' }).click();
  await expect(page.getByText('Đã tạo nhóm khách.')).toBeVisible();

  await page.goto(`/customers?q=${PHONE}`);
  await page.getByRole('link', { name: 'Nguyễn Văn Test' }).click();
  await page.getByLabel('Nhóm khách').selectOption({ label: `Đối tác ${SUFFIX}` });
  await page.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await expect(page.getByText('Đã lưu.')).toBeVisible();

  await page.goto('/pricing/quote');
  const modelId = await page.locator('select[name=model] option', { hasText: MODEL }).getAttribute('value');
  const custId = await page.locator('select[name=customer] option', { hasText: PHONE }).getAttribute('value');
  await page.goto(`/pricing/quote?model=${modelId}&customer=${custId}&start=2026-11-02T08:00&end=2026-11-03T08:00`);
  await expect(page.getByTestId('quote-total')).toHaveText(/450\.000\s*đ/); // 500k − 10%
  await expect(page.getByText(/giảm 10%/)).toBeVisible();

  await page.goto('/settings/pricing');
  await page.getByLabel('Tính VAT').check();
  await page.getByLabel('VAT (%)').fill('10');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu quy tắc tính giá.')).toBeVisible();
  await page.goto(`/pricing/quote?model=${modelId}&customer=${custId}&start=2026-11-02T08:00&end=2026-11-03T08:00`);
  await expect(page.getByTestId('quote-total')).toHaveText(/495\.000\s*đ/); // 450k + 10% VAT
});

test('nhân viên quầy xem được bảng giá nhưng không sửa giá, không vào được quy tắc tính giá', async ({ page }) => {
  await login(page, 'staff');
  await page.goto('/pricing');
  await expect(page.getByRole('row', { name: new RegExp(MODEL) })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lưu' })).toHaveCount(0);
  await page.goto('/settings/pricing');
  await expect(page).toHaveURL(/\/\?error=/);
});

test('ẩn danh khách hàng: xóa dữ liệu cá nhân và ảnh, khách biến khỏi danh sách', async ({ page }) => {
  await login(page, 'owner');
  await page.goto(`/customers?q=${PHONE}`);
  await page.getByRole('link', { name: 'Nguyễn Văn Test' }).click();
  await page.getByLabel('Tôi hiểu thao tác này không thể hoàn tác').check();
  await page.getByRole('button', { name: 'Ẩn danh khách hàng này' }).click();
  await expect(page.getByText('Đã ẩn danh khách hàng.')).toBeVisible();
  await page.goto(`/customers?q=${PHONE}`);
  await expect(page.getByRole('link', { name: 'Nguyễn Văn Test' })).toHaveCount(0);
  await expect(page.getByText('Chưa có khách hàng phù hợp.')).toBeVisible();
});
