import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createPool } from '@rentpro/db';
import { E2E_PASSWORD } from '../global-setup';
import { pageFetch } from './helpers';

test.use({ baseURL: process.env.E2E_TENANT_URL });
test.describe.configure({ mode: 'serial' });

const SUFFIX = Number(String(Date.now()).slice(-4));
// Khung giờ riêng cho bộ này: mỗi đơn một cửa sổ cách nhau 3 ngày, xa các bộ test khác
const DAY = 2 + (SUFFIX % 8);
const win = (n: number) => ({ start: `2028-01-${String(DAY + n * 3).padStart(2, '0')}T08:00`, end: `2028-01-${String(DAY + n * 3 + 1).padStart(2, '0')}T08:00` });
const ROOT = resolve(process.cwd(), '..'); // Playwright chạy với cwd = thư mục e2e
const db = () => createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');

async function login(page: Page, role: 'owner' | 'staff' | 'technician') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(`${role}@e2e.local`);
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

/** Tạo đơn đã xác nhận qua giao diện, trả về id đơn. */
async function createBooking(page: Page, n: number): Promise<string> {
  const w = win(n);
  await page.goto('/bookings/new');
  const cust = await page.locator('select[name=customer] option', { hasText: 'Khách Đặt A' }).getAttribute('value');
  await page.locator('select[name=customer]').selectOption(cust!);
  await page.getByLabel('Nhận thiết bị', { exact: false }).fill(w.start);
  await page.getByLabel('Trả thiết bị').fill(w.end);
  const m = await page.locator('select[name=m1] option', { hasText: 'Sony A7 E2E' }).getAttribute('value');
  await page.locator('select[name=m1]').selectOption(m!);
  await page.locator('input[name=q1]').fill('1');
  await page.getByRole('button', { name: 'Tính giá & kiểm tra lịch' }).click();
  await page.getByRole('button', { name: 'Xác nhận đơn' }).click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}/);
  return page.url().split('?')[0]!.split('/').pop()!;
}

/** Chạy worker một vòng như khi triển khai thật (tiến trình riêng, đọc cấu hình từ biến môi trường). */
function runWorkerOnce() {
  return execSync('pnpm --filter @rentpro/worker once', {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PUBLIC_URL_TEMPLATE: 'http://{slug}.localhost:3000', FILE_URL_SECRET: 'e2e-file-url-secret-not-for-production' }, // cùng bí mật với máy chủ web để liên kết ký hợp lệ
  });
}

const sql = async (q: string, args: unknown[] = []) => { const p = db(); try { return (await p.query(q, args)).rows; } finally { await p.end(); } };

test('cấu hình thông báo: lưu, mẫu tin sai bị từ chối bằng tiếng Việt, gửi thử ở chế độ giả lập', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/settings/notifications');
  await page.locator('input[name=quietEnabled]').uncheck(); // test chạy giờ nào cũng được
  await page.locator('textarea[name=tpl_DUE]').fill('Xin {xyz}');
  await page.getByRole('button', { name: 'Lưu cấu hình' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Biến không hợp lệ');
  await page.locator('input[name=quietEnabled]').uncheck();
  await page.locator('textarea[name=tpl_DUE]').fill('Đơn {ma_don} của {ten_khach} đã đến hạn trả lúc {han_tra}.');
  await page.getByRole('button', { name: 'Lưu cấu hình' }).click();
  await expect(page.getByText('Đã lưu cấu hình thông báo.')).toBeVisible();
  await expect(page.locator('textarea[name=tpl_DUE]')).toHaveValue(/^Đơn \{ma_don\} của/);

  await page.locator('[data-testid=notify-test] input[name=testTo]').fill('khong-phai-so');
  await page.locator('[data-testid=notify-test] select[name=testChannel]').selectOption('sms');
  await page.getByRole('button', { name: 'Gửi thử' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Số điện thoại không hợp lệ');
  await page.locator('[data-testid=notify-test] select[name=testChannel]').selectOption('sms'); // trang tải lại sau lỗi nên ô chọn về mặc định
  await page.locator('[data-testid=notify-test] input[name=testTo]').fill('0912345678');
  await page.getByRole('button', { name: 'Gửi thử' }).click();
  await expect(page.getByText(/chế độ giả lập/)).toBeVisible();
});

test('worker: đơn sắp đến hạn được nhắc một lần, tin ghi nhận "đã gửi"; chạy lại không gửi trùng', async ({ page }) => {
  await login(page, 'owner');
  const id = await createBooking(page, 0);
  await sql("UPDATE booking SET status='ACTIVE', starts_at=now() - interval '1 day', ends_at=now() + interval '2 hours', delivered_at=now() WHERE id=$1", [id]);
  const out1 = runWorkerOnce();
  expect(out1).toMatch(/\[worker\] \d+ tenant/);
  const rows1 = await sql("SELECT event, status, channel, scope, body FROM notification_log WHERE booking_id=$1", [id]);
  expect(rows1).toHaveLength(1);
  expect(rows1[0]).toMatchObject({ event: 'BEFORE_DUE', status: 'SENT', channel: 'sms', scope: 'CONSOLE' });
  expect(rows1[0].body).toContain('Khách Đặt A');
  runWorkerOnce();
  expect(await sql('SELECT 1 FROM notification_log WHERE booking_id=$1', [id])).toHaveLength(1);

  await page.goto('/notifications');
  const row = page.getByTestId('notification-table').locator('tr', { hasText: 'Sắp đến hạn trả' }).first();
  await expect(row).toContainText('Đã gửi');
  await expect(row).toContainText('(giả lập)');
  await expect(row).toContainText('0911000001');
});

test('quá hạn: tin nhắc cho khách và cảnh báo trong hộp thư của quản lý; đánh dấu đã đọc', async ({ page }) => {
  await login(page, 'owner');
  const id = await createBooking(page, 1);
  await sql("UPDATE booking SET status='ACTIVE', starts_at=now() - interval '3 days', ends_at=now() - interval '25 hours', delivered_at=now() - interval '3 days' WHERE id=$1", [id]);
  runWorkerOnce();
  const rows = await sql('SELECT event FROM notification_log WHERE booking_id=$1', [id]);
  expect(rows.map((r) => r.event)).toEqual(['OVERDUE']);

  await page.goto('/inbox');
  const item = page.getByTestId('inbox-list').locator('li', { hasText: 'quá hạn trả' }).first();
  await expect(item).toBeVisible();
  await expect(page.getByTestId('inbox-link')).toContainText(/\d/); // có số chưa đọc trên thanh menu
  await item.getByRole('button', { name: 'Đã đọc' }).click();
  await expect(page.getByTestId('inbox-list').locator('li', { hasText: 'quá hạn trả' }).first().getByRole('button', { name: 'Đã đọc' })).toHaveCount(0);

  // nhân viên quầy không thấy cảnh báo dành cho quản lý
  await login(page, 'staff');
  await page.goto('/inbox');
  await expect(page.getByText('quá hạn trả')).toHaveCount(0);
});

test('công nợ sau khi nhận lại: tin có liên kết thanh toán công khai, khách mở được và thấy QR; liên kết giả bị từ chối', async ({ page, browser }) => {
  await login(page, 'owner');
  await page.goto('/settings/finance');
  await page.locator('select[name=bin]').selectOption('970436');
  await page.locator('input[name=account]').fill('0123456789');
  await page.locator('input[name=accountName]').fill('CUA HANG E2E');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu cấu hình tài chính.')).toBeVisible();

  const id = await createBooking(page, 2);
  await sql("UPDATE booking SET status='RETURNED', total=730000, starts_at=now() - interval '5 days', ends_at=now() - interval '4 days', delivered_at=now() - interval '5 days', returned_at=now() - interval '3 days' WHERE id=$1", [id]);
  runWorkerOnce();
  const rows = await sql("SELECT body FROM notification_log WHERE booking_id=$1 AND event='DEBT'", [id]);
  expect(rows).toHaveLength(1);
  const m = /(http:\/\/\S+?\/pay\/[\w.-]+?)\.? /.exec(`${rows[0].body} `);
  expect(m, rows[0].body).not.toBeNull();
  const link = m![1]!;
  expect(rows[0].body).toContain('730.000 đ');

  // khách chưa đăng nhập mở liên kết
  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await gp.goto(link);
  await expect(gp.getByTestId('pay-amount')).toHaveText(/730\.000\s*đ/);
  await expect(gp.getByText('Nội dung chuyển khoản:')).toBeVisible();
  const img = gp.getByAltText('Mã QR chuyển khoản');
  await expect(img).toBeVisible();
  expect(await img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);
  expect(await gp.locator('body').innerText()).not.toContain('Khách Đặt A'); // không lộ tên khách
  // liên kết bị sửa thì không dùng được
  await gp.goto(link.slice(0, -3) + 'abc');
  await expect(gp.getByText('Liên kết không hợp lệ hoặc đã hết hạn')).toBeVisible();
  const bad = await pageFetch(gp, `${new URL(link).pathname.replace(/.$/, 'x')}/qr`);
  expect(bad.status).toBe(403);
  await guest.close();
});

test('phân quyền: nhân viên xem được nhật ký nhưng không vào cấu hình; kỹ thuật viên không thấy tin nhắn', async ({ page }) => {
  await login(page, 'staff');
  await page.goto('/notifications');
  await expect(page.getByTestId('notification-table')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gửi lại' })).toHaveCount(0);
  await page.goto('/settings/notifications');
  await expect(page.getByText(/quyền|Không có/i).first()).toBeVisible();
  await login(page, 'technician');
  await page.goto('/notifications');
  await expect(page.getByText(/quyền|Không có/i).first()).toBeVisible();
});
