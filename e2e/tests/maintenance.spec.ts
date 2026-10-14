import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createPool } from '@rentpro/db';
import { E2E_PASSWORD } from '../global-setup';

test.use({ baseURL: process.env.E2E_TENANT_URL });
test.describe.configure({ mode: 'serial' });

const ROOT = resolve(process.cwd(), '..');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const sql = async (q: string, args: unknown[] = []) => {
  const p = createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');
  try { return (await p.query(q, args)).rows; } finally { await p.end(); }
};
const tenantId = () => process.env.E2E_TENANT_ID!;

async function login(page: Page, role: 'owner' | 'staff' | 'technician') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(`${role}@e2e.local`);
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

let planOrderUrl = '';

test('kế hoạch định kỳ: tạo kế hoạch theo ngày; số ngày sai bị từ chối bằng tiếng Việt', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/maintenance/plans');
  const form = page.getByTestId('plan-form');
  await form.locator('input[name=name]').fill('Vệ sinh E2E');
  await form.getByRole('button', { name: 'Thêm kế hoạch' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('ít nhất một điều kiện');
  await form.locator('input[name=name]').fill('Vệ sinh E2E');
  await form.locator('select[name=modelId]').selectOption({ label: 'Sony A7 E2E' });
  await form.locator('input[name=everyDays]').fill('90');
  await form.locator('textarea[name=checklist]').fill('Vệ sinh cảm biến\nCập nhật firmware');
  await form.getByRole('button', { name: 'Thêm kế hoạch' }).click();
  await expect(page.getByText('Đã tạo kế hoạch bảo trì.')).toBeVisible();
  await expect(page.getByTestId('plan-table')).toContainText('Vệ sinh E2E');
  await expect(page.getByTestId('plan-table')).toContainText('90 ngày');
});

test('worker: thiết bị quá hạn bảo trì được tạo phiếu, tự xếp khung giờ, báo quản lý trong hộp thư', async ({ page }) => {
  const unit = (await sql("SELECT id FROM equipment_unit WHERE tenant_id=$1 AND barcode='CAM-000003'", [tenantId()]))[0].id;
  await sql("UPDATE equipment_unit SET created_at = now() - interval '120 days' WHERE id=$1", [unit]);
  const out = execSync('pnpm --filter @rentpro/worker once', { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  expect(out).toMatch(/\[worker\] \d+ tenant/);
  const orders = await sql("SELECT id, status, scheduled_start FROM work_order WHERE tenant_id=$1 AND source='PLAN'", [tenantId()]);
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({ status: 'PENDING' });
  expect(orders[0].scheduled_start).not.toBeNull();

  await login(page, 'owner');
  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-list')).toContainText('CAM-000003 đến hạn bảo trì');
  await page.goto('/maintenance');
  const card = page.getByTestId('order-list').locator('li', { hasText: 'CAM-000003' });
  await expect(card).toContainText('Vệ sinh E2E');
  await expect(card).toContainText('Chờ làm');
  await expect(page.getByTestId('maint-summary')).toContainText('Chờ làm');
  planOrderUrl = `/maintenance/${orders[0].id}`;
});

test('kỹ thuật viên làm phiếu: bắt đầu → checklist → chi phí → ảnh → hoàn thành; thiết bị đi Bảo trì rồi về Rảnh', async ({ page }) => {
  await login(page, 'technician');
  await page.goto(planOrderUrl);
  await expect(page.getByTestId('unit-status')).toHaveText('AVAILABLE');
  await page.getByTestId('start-order').click();
  await expect(page.getByText(/Đã bắt đầu/)).toBeVisible();
  await expect(page.getByTestId('order-status')).toHaveText('Đang làm');
  await expect(page.getByTestId('unit-status')).toHaveText('MAINTENANCE');

  // chưa xong checklist thì chưa hoàn thành được
  await page.getByTestId('finish-order').click();
  await expect(page.locator('p[role=alert]')).toContainText('Còn 2 mục checklist chưa xong');
  await page.getByRole('button', { name: /Vệ sinh cảm biến/ }).click();
  await page.getByRole('button', { name: /Cập nhật firmware/ }).click();
  await expect(page.getByTestId('checklist').getByText('☑')).toHaveCount(2);

  const edit = page.getByTestId('order-edit');
  await edit.locator('input[name=laborCost]').fill('150000');
  await edit.locator('textarea[name=parts]').fill('Tấm lọc | 2 | 50000');
  await edit.getByRole('button', { name: 'Lưu phiếu' }).click();
  await expect(page.getByText('Đã lưu phiếu.')).toBeVisible();
  await expect(page.getByTestId('order-cost')).toContainText('250.000');

  await page.locator('input[name=photos]').first().setInputFiles({ name: 'truoc.png', mimeType: 'image/png', buffer: PNG });
  await page.getByRole('button', { name: 'Tải lên' }).first().click();
  await expect(page.getByText('Đã thêm ảnh.')).toBeVisible();
  await expect(page.getByAltText('Ảnh trước 1')).toBeVisible();

  await page.getByTestId('finish-order').click();
  await expect(page.getByText(/Đã hoàn thành phiếu/)).toBeVisible();
  await expect(page.getByTestId('order-status')).toHaveText('Hoàn thành');
  await expect(page.getByTestId('unit-status')).toHaveText('AVAILABLE');
  await expect(page.getByTestId('order-edit')).toHaveCount(0); // phiếu xong không sửa nữa
  // kỹ thuật viên không thấy mục tiền
  await expect(page.getByTestId('charge-section')).toHaveCount(0);
});

test('nhân viên quầy xem được bảng việc nhưng không tạo/sửa được phiếu', async ({ page }) => {
  await login(page, 'staff');
  await page.goto('/maintenance');
  await expect(page.getByRole('heading', { name: 'Bảo trì và sửa chữa' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tạo phiếu' })).toHaveCount(0);
  await page.goto('/maintenance/new');
  await expect(page.getByText(/quyền|Không có/i).first()).toBeVisible();
  await page.goto(planOrderUrl);
  await expect(page.getByTestId('order-status')).toHaveText('Hoàn thành');
  await expect(page.getByRole('button', { name: 'Bắt đầu làm' })).toHaveCount(0);
});

test('quản lý tạo phiếu thủ công có giữ lịch; không sửa được thì thanh lý, thiết bị thành "Đã thanh lý"', async ({ page }) => {
  const model = (await sql("SELECT model_id FROM equipment_unit WHERE tenant_id=$1 AND barcode='CAM-000001'", [tenantId()]))[0].model_id;
  await sql("INSERT INTO equipment_unit(tenant_id,model_id,barcode) VALUES ($1,$2,'CAM-009999')", [tenantId(), model]);
  await login(page, 'owner');
  await page.goto('/maintenance/new');
  await page.locator('select[name=unitId]').selectOption({ label: 'CAM-009999 · Sony A7 E2E' });
  await page.locator('input[name=title]').fill('Thay màn hình');
  await page.locator('select[name=kind]').selectOption('REPAIR');
  await page.locator('textarea[name=checklist]').fill('Tháo máy');
  await page.locator('input[name=windowStart]').fill('2028-06-10T08:00');
  await page.locator('input[name=windowEnd]').fill('2028-06-10T12:00');
  await page.getByRole('button', { name: 'Tạo phiếu' }).click();
  await expect(page.getByText('Đã tạo phiếu.')).toBeVisible();
  await expect(page.getByTestId('order-code')).toHaveText(/^BT-\d{4}-\d{5}$/);
  await expect(page.getByText('Khung giờ giữ lịch')).toBeVisible();
  const alloc = await sql("SELECT status FROM unit_allocation WHERE tenant_id=$1 AND status='MAINTENANCE' AND unit_id=(SELECT id FROM equipment_unit WHERE barcode='CAM-009999' AND tenant_id=$1)", [tenantId()]);
  expect(alloc).toHaveLength(1);

  await page.getByTestId('start-order').click();
  await expect(page.getByTestId('unit-status')).toHaveText('MAINTENANCE');
  await page.locator('input[name=reason]').first().fill('Vỡ bo mạch, hết linh kiện');
  await page.getByRole('button', { name: 'Không sửa được' }).click();
  await expect(page.getByTestId('order-status')).toHaveText('Không sửa được');
  await page.locator('input[name=reason]').fill('Hết khấu hao');
  await page.getByRole('button', { name: 'Thanh lý thiết bị' }).click();
  await expect(page.getByText('Đã thanh lý thiết bị.')).toBeVisible();
  await expect(page.getByTestId('unit-status')).toHaveText('RETIRED');
  // khung giữ lịch đã trả
  expect(await sql("SELECT 1 FROM unit_allocation WHERE tenant_id=$1 AND status='MAINTENANCE'", [tenantId()])).toHaveLength(0);
});

test('quét mã thiết bị: có phiếu thì mở phiếu, chưa có thì mời tạo; mã lạ báo lỗi', async ({ page }) => {
  await login(page, 'technician');
  await page.goto('/maintenance/scan');
  const input = page.getByPlaceholder(/Quét hoặc nhập mã/);
  await input.fill('KHONG-CO');
  await input.press('Enter');
  await expect(page.getByText('Không tìm thấy thiết bị với mã này.')).toBeVisible();
  await input.fill('cam-000002');
  await input.press('Enter');
  await expect(page.getByText(/chưa có phiếu, bấm để tạo/)).toBeVisible();
  // CAM-000001 bị hỏng khi trả ở bộ test tài chính nên đã có phiếu sửa chữa tự sinh
  await input.fill('CAM-000001');
  await input.press('Enter');
  await expect(page.getByText(/mở phiếu đang làm/)).toBeVisible();
  await expect(page.getByRole('link', { name: /mở phiếu đang làm/ })).toHaveAttribute('href', /\/maintenance\/[0-9a-f-]{36}/);
});
