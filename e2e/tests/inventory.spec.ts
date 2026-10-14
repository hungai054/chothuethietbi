import { test, expect, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { IMPORT_COLUMNS } from '@rentpro/core';
import { E2E_PASSWORD } from '../global-setup';
import { pageFetch } from './helpers';

test.use({ baseURL: process.env.E2E_TENANT_URL });
test.describe.configure({ mode: 'serial' });

const PREFIX = `T${String(Date.now()).slice(-6)}`;

async function login(page: Page, role: 'owner' | 'staff' | 'technician') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(`${role}@e2e.local`);
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Thiết bị', exact: true })).toBeVisible();
}

async function xlsxFile(rows: Record<string, string>[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Thiết bị');
  ws.addRow(IMPORT_COLUMNS.map((c) => c.header));
  for (const r of rows) ws.addRow(IMPORT_COLUMNS.map((c) => r[c.key] ?? ''));
  return { name: 'nhap.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

test('chủ cửa hàng tạo danh mục, mẫu và thiết bị hàng loạt với mã vạch tự sinh', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/inventory/models');
  await page.locator('form', { hasText: 'Thêm danh mục' }).getByLabel('Tên danh mục').fill('Máy ảnh');
  await page.getByRole('button', { name: 'Tạo danh mục' }).click();
  await expect(page.getByText('Đã tạo danh mục.')).toBeVisible();

  const f = page.locator('form', { hasText: 'Thêm mẫu' });
  await f.getByLabel('Tên mẫu (*)').fill('Sony A7 IV');
  await f.getByLabel('Hãng').fill('Sony');
  await f.getByLabel('Danh mục').selectOption({ label: 'Máy ảnh' });
  await f.getByLabel('Tiền tố mã vạch').fill(PREFIX);
  await page.getByRole('button', { name: 'Tạo mẫu' }).click();
  await expect(page.getByText('Đã tạo mẫu thiết bị.')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Sony A7 IV/ })).toBeVisible();

  await page.goto('/inventory/units/new');
  await page.getByLabel('Mẫu (*)').selectOption({ label: 'Sony A7 IV' });
  await page.getByLabel('Số lượng (tạo hàng loạt)').fill('3');
  await page.getByRole('button', { name: 'Tạo thiết bị' }).click();
  await expect(page.getByText(`Đã tạo 3 thiết bị: ${PREFIX}-000001, ${PREFIX}-000002, ${PREFIX}-000003`)).toBeVisible();
  await expect(page.getByRole('link', { name: `${PREFIX}-000002` })).toBeVisible();
});

test('đổi trạng thái: bắt buộc lý do, không có lựa chọn do hệ thống điều khiển, có lịch sử', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/inventory');
  await page.getByRole('link', { name: `${PREFIX}-000001` }).click();
  await expect(page.getByRole('button', { name: /→ Đã giữ chỗ|→ Đang thuê/ })).toHaveCount(0);
  await page.locator('form', { has: page.getByRole('button', { name: '→ Bảo trì' }) }).getByPlaceholder('Lý do (bắt buộc)').fill('Vệ sinh cảm biến');
  await page.getByRole('button', { name: '→ Bảo trì' }).click();
  await expect(page.getByText('Đã cập nhật trạng thái.')).toBeVisible();
  await expect(page.getByText('Trạng thái: Bảo trì')).toBeVisible();
  await expect(page.getByText(/Rảnh → Bảo trì · Vệ sinh cảm biến/)).toBeVisible();
  await page.getByRole('button', { name: '→ Rảnh' }).click();
  await expect(page.getByText('Trạng thái: Rảnh')).toBeVisible();
});

test('quét mã bằng máy quét USB (gõ mã + Enter), không phân biệt hoa thường', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/inventory/scan');
  const box = page.getByLabel('Mã vạch');
  await box.fill(`${PREFIX.toLowerCase()}-000002`);
  await box.press('Enter');
  await expect(page.getByText('Sony A7 IV · Rảnh')).toBeVisible();
  await box.fill('KHONG-CO');
  await box.press('Enter');
  await expect(page.getByText('Không tìm thấy thiết bị với mã này.')).toBeVisible();
});

test('in tem: trang HTML có Code128 + QR và tên thiết bị', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/inventory');
  await page.getByLabel(`Chọn ${PREFIX}-000001`).check();
  await page.getByLabel(`Chọn ${PREFIX}-000002`).check();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'In tem cho thiết bị đã chọn' }).click();
  const tem = await popup;
  await expect(tem.locator('.label')).toHaveCount(2);
  await expect(tem.locator('svg')).toHaveCount(4);
  await expect(tem.getByText('Sony A7 IV').first()).toBeVisible();
});

test('nhập Excel: xem trước báo lỗi từng dòng, chặn nhập; sửa xong thì nhập được', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/inventory/import');
  const bad = await xlsxFile([{ model: 'Canon R5', serial: 'C1' }, { model: '', serial: 'C2' }, { model: 'Lens 50', branch: 'Kho lạ' }]);
  await page.locator('input[type=file]').setInputFiles(bad);
  await page.getByRole('button', { name: 'Xem trước & kiểm tra' }).click();
  await expect(page.getByText('Tổng 3 dòng')).toBeVisible();
  await expect(page.getByText('Bắt buộc nhập tên mẫu.')).toBeVisible();
  await expect(page.getByText('Không có chi nhánh "Kho lạ".')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Nhập/ })).toBeDisabled();

  const good = await xlsxFile([{ category: 'Máy ảnh', model: 'Canon R5', serial: 'C1', condition: 'Mới' }, { model: 'Lens 50', branch: 'Chi nhánh chính' }]);
  await page.locator('input[type=file]').setInputFiles(good);
  await page.getByRole('button', { name: 'Xem trước & kiểm tra' }).click();
  await expect(page.getByText('2 hợp lệ')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nhập 2 thiết bị' })).toBeEnabled();
  await page.getByRole('button', { name: 'Nhập 2 thiết bị' }).click();
  await expect(page.getByText('Đã nhập 2 thiết bị.')).toBeVisible();

  await page.goto('/inventory?q=Canon');
  await expect(page.getByRole('cell', { name: /Canon R5/ })).toBeVisible();
  // nhập lại cùng file: serial trùng bị chặn
  await page.goto('/inventory/import');
  await page.locator('input[type=file]').setInputFiles(good);
  await page.getByRole('button', { name: 'Xem trước & kiểm tra' }).click();
  await expect(page.getByText(/Serial "C1" của mẫu này đã tồn tại/)).toBeVisible();
});

test('xuất Excel tải về được', async ({ page }) => {
  await login(page, 'owner');
  const res = await pageFetch(page, '/inventory/export');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('spreadsheetml');
  expect(String.fromCharCode(...res.bytes.slice(0, 2))).toBe('PK'); // file zip/xlsx
});

test('kiểm kê: quét thiếu thì báo thiếu, đóng đợt thì không quét thêm', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/inventory/stocktake');
  await page.getByLabel('Tên đợt kiểm kê').fill('Kiểm kê E2E');
  await page.getByRole('button', { name: 'Bắt đầu' }).click();
  await expect(page.getByRole('heading', { name: /Kiểm kê E2E/ })).toBeVisible();
  const box = page.getByLabel('Mã vạch');
  for (const n of [1, 2]) { await box.fill(`${PREFIX}-00000${n}`); await box.press('Enter'); await expect(page.getByText('Khớp').first()).toBeVisible(); }
  await box.fill(`${PREFIX}-000001`);
  await box.press('Enter');
  await expect(page.getByText('Đã quét trước đó')).toBeVisible();
  await page.reload();
  await expect(page.getByText(`Thiếu (chưa quét được)`)).toBeVisible();
  await expect(page.getByRole('link', { name: `${PREFIX}-000003` })).toBeVisible();
  await page.getByRole('button', { name: 'Đóng đợt kiểm kê' }).click();
  await expect(page.getByText('(đã đóng)')).toBeVisible();
  await expect(page.getByLabel('Mã vạch')).toHaveCount(0);
});

test('nhân viên quầy: xem được nhưng không có nút tạo/nhập; vào thẳng URL bị chặn', async ({ page }) => {
  await login(page, 'staff');
  await page.goto('/inventory');
  await expect(page.getByRole('link', { name: 'Thêm thiết bị' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Nhập Excel' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Kiểm kê' })).toHaveCount(0);
  await page.goto('/inventory/import');
  await expect(page).toHaveURL(/\/inventory\?error=/);
  await expect(page.locator('p[role=alert]')).toContainText('Bạn không có quyền');
  await page.goto('/inventory/models');
  await expect(page.getByRole('button', { name: 'Tạo mẫu' })).toHaveCount(0);
});

test('kỹ thuật viên kiểm kê được và quản lý thiết bị', async ({ page }) => {
  await login(page, 'technician');
  await expect(page.getByRole('link', { name: 'Kiểm kê' })).toBeVisible();
  await page.goto('/inventory');
  await expect(page.getByRole('link', { name: 'Thêm thiết bị' })).toBeVisible();
});

test('tenant khác không truy cập được thiết bị của tenant này (kể cả biết URL chi tiết)', async ({ page, browser }) => {
  await login(page, 'owner');
  await page.goto('/inventory');
  await page.getByRole('link', { name: `${PREFIX}-000001` }).click();
  await page.waitForURL(/\/inventory\/units\//);
  const detailPath = new URL(page.url()).pathname;
  expect(detailPath).toMatch(/^\/inventory\/units\/[0-9a-f-]{36}$/);
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await other.goto(`http://demo.localhost:3000/login`);
  await other.getByPlaceholder('Email').fill('owner@demo.local');
  await other.getByPlaceholder('Mật khẩu').fill('Demo@12345678');
  await other.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(other.getByRole('link', { name: 'Thiết bị', exact: true })).toBeVisible();
  const res = await other.goto(`http://demo.localhost:3000${detailPath}`);
  expect(res?.status()).toBe(404);
  await expect(other.getByText(PREFIX)).toHaveCount(0);
  await expect(other.getByText('Vệ sinh cảm biến')).toHaveCount(0);
  await ctx.close();
});
