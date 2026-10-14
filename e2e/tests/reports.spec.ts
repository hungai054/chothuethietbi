import { test, expect, type Page } from '@playwright/test';
import { createPool } from '@rentpro/db';
import { E2E_PASSWORD } from '../global-setup';
import { pageFetch } from './helpers';

test.use({ baseURL: process.env.E2E_TENANT_URL });
test.describe.configure({ mode: 'serial' });

const sql = async (q: string, args: unknown[] = []) => {
  const p = createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');
  try { return (await p.query(q, args)).rows; } finally { await p.end(); }
};

async function login(page: Page, email: string, base?: string) {
  await page.context().clearCookies();
  await page.goto(`${base ?? ''}/login`);
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

test('chủ cửa hàng thấy đủ 9 báo cáo; trang chủ hiện tổng quan hôm nay', async ({ page }) => {
  await login(page, 'owner@e2e.local');
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('report-cards')).toContainText('Đơn đang thuê');
  await expect(page.getByTestId('report-cards')).toContainText('Doanh thu tháng này');
  await page.getByRole('link', { name: 'Báo cáo' }).click();
  await expect(page.getByTestId('report-list').locator('li')).toHaveCount(9);
  for (const t of ['Doanh thu', 'Quá hạn và công nợ', 'Hoàn vốn (ROI)', 'Hiệu suất sử dụng', 'Khách hàng', 'Tồn kho và kiểm kê']) await expect(page.getByTestId('report-list')).toContainText(t);
});

test('báo cáo doanh thu: có biểu đồ khi có tiền thu, đổi cách nhóm, bộ lọc sai báo lỗi tiếng Việt', async ({ page }) => {
  const b = (await sql('SELECT id FROM booking WHERE tenant_id=$1 LIMIT 1', [process.env.E2E_TENANT_ID]))[0].id;
  await sql("INSERT INTO payment(tenant_id,booking_id,kind,method,amount,paid_at) VALUES ($1,$2,'RENT','CASH',123000, now())", [process.env.E2E_TENANT_ID, b]);
  await login(page, 'owner@e2e.local');
  await page.goto('/reports/revenue');
  await expect(page.getByTestId('report-title')).toHaveText('Doanh thu');
  await expect(page.getByTestId('report-period')).toContainText('Kỳ:');
  await expect(page.getByTestId('report-section').filter({ hasText: 'Thực thu' })).toContainText('123.000 đ');
  await expect(page.getByTestId('chart').first()).toBeVisible();
  await page.locator('select[name=groupBy]').selectOption('model');
  await page.getByRole('button', { name: 'Xem báo cáo' }).click();
  await expect(page).toHaveURL(/groupBy=model/);
  await expect(page.getByTestId('report-section').first()).toContainText('Mẫu thiết bị');
  await page.goto('/reports/revenue?from=2027-13-01');
  await expect(page.locator('p[role=alert]')).toContainText('Ngày bắt đầu không hợp lệ');
  await page.goto('/reports/revenue?from=2027-03-10&to=2027-03-01');
  await expect(page.locator('p[role=alert]')).toContainText('Ngày bắt đầu phải trước');
});

test('xuất Excel: tải về được tệp .xlsx hợp lệ, đúng bộ lọc; lỗi bộ lọc trả 400', async ({ page }) => {
  await login(page, 'owner@e2e.local');
  await page.goto('/reports/revenue');
  const r = await pageFetch(page, '/reports/revenue/export?groupBy=month');
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toContain('spreadsheetml.sheet');
  expect(r.headers['content-disposition']).toMatch(/bao-cao-revenue-\d{8}\.xlsx/);
  expect(r.bytes.slice(0, 2)).toEqual([0x50, 0x4b]); // "PK": tệp zip/xlsx
  expect(r.bytes.length).toBeGreaterThan(2000);
  expect((await pageFetch(page, '/reports/revenue/export?from=khong-hop-le')).status).toBe(400);
  expect((await pageFetch(page, '/reports/khong-co/export')).status).toBe(400);
  const log = await sql("SELECT count(*)::int n FROM audit_log WHERE tenant_id=$1 AND action='report.export'", [process.env.E2E_TENANT_ID]);
  expect(log[0].n).toBeGreaterThanOrEqual(1);
});

test('các báo cáo còn lại mở được, không lỗi', async ({ page }) => {
  await login(page, 'owner@e2e.local');
  for (const [key, title] of [['debts', 'Quá hạn và công nợ'], ['deposits', 'Tiền cọc và tài sản cọc'], ['inventory', 'Tồn kho và kiểm kê'], ['utilization', 'Hiệu suất sử dụng'], ['roi', 'Hoàn vốn'], ['maintenance', 'Bảo trì'], ['customers', 'Khách hàng']] as const) {
    await page.goto(`/reports/${key}`);
    await expect(page.getByTestId('report-title')).toContainText(title);
    await expect(page.locator('p[role=alert]')).toHaveCount(0);
    await expect(page.getByTestId('report-section').first()).toBeVisible();
  }
});

test('nhân viên quầy chỉ xem được báo cáo không có tiền; xuất báo cáo tiền bị từ chối', async ({ page }) => {
  await login(page, 'staff@e2e.local');
  await expect(page.getByTestId('report-cards')).toContainText('Đơn đang thuê');
  await expect(page.getByTestId('report-cards')).not.toContainText('Doanh thu');
  await page.goto('/reports');
  await expect(page.getByTestId('report-list').locator('li')).toHaveCount(3);
  await page.goto('/reports/revenue');
  await expect(page.getByText(/quyền|Không có/i).first()).toBeVisible();
  expect((await pageFetch(page, '/reports/revenue/export')).status).toBe(403);
  expect((await pageFetch(page, '/reports/inventory/export')).status).toBe(200);
});

test('kỹ thuật viên không có báo cáo; gói Cơ bản không có báo cáo nâng cao', async ({ page }) => {
  await login(page, 'technician@e2e.local');
  await expect(page.getByRole('link', { name: 'Báo cáo' })).toHaveCount(0);
  await page.goto('/reports/inventory');
  await expect(page.getByText(/quyền|Không có/i).first()).toBeVisible();
  const base = process.env.E2E_BASIC_URL!;
  await login(page, 'owner@e2e-basic.local', base);
  await page.goto(`${base}/reports`);
  await expect(page.getByTestId('report-list').locator('li')).toHaveCount(5);
  await page.goto(`${base}/reports/utilization`);
  await expect(page.getByText(/gói|Không có/i).first()).toBeVisible();
  expect((await pageFetch(page, `${base}/reports/roi/export`)).status).toBe(403);
});
