import { test, expect, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';
import { pageFetch } from './helpers';

test.use({ baseURL: process.env.E2E_TENANT_URL });
test.describe.configure({ mode: 'serial' });

const SUFFIX = Number(String(Date.now()).slice(-4));
// Khung giờ riêng, xa các bộ test khác (tháng 8-9 năm 2027)
const DAY = 8 + (SUFFIX % 20);
const START = `2027-09-${String(DAY).padStart(2, '0')}T08:00`;
const END = `2027-09-${String(DAY + 1).padStart(2, '0')}T08:00`;

async function login(page: Page, role: 'owner' | 'staff' | 'technician') {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(`${role}@e2e.local`);
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

async function scribble(page: Page, testId: string) {
  await page.getByTestId(testId).scrollIntoViewIfNeeded();
  const box = (await page.getByTestId(testId).boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 30 + i * 18, box.y + 40 + (i % 2 ? 50 : -10), { steps: 3 });
  await page.mouse.up();
}

let bookingUrl = '';
const bookingPath = () => new URL(bookingUrl).pathname;

test('cấu hình tài chính: tài khoản nhận tiền, cọc cố định 1.000.000, thông tin cửa hàng', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/settings/finance');
  await page.locator('select[name=bin]').selectOption('970436');
  await page.locator('input[name=account]').fill('0123456789');
  await page.locator('input[name=accountName]').fill('CUA HANG E2E');
  await page.locator('select[name=depositMode]').selectOption('FIXED');
  await page.locator('input[name=depositValue]').fill('1000000');
  await page.locator('input[name=storeName]').fill('Cửa hàng E2E');
  await page.locator('input[name=storeAddress]').fill('1 Lê Lợi, Quận 1');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu cấu hình tài chính.')).toBeVisible();
  // số tài khoản sai bị từ chối bằng thông báo tiếng Việt
  await page.locator('input[name=account]').fill('12ab');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Số tài khoản');
});

test('đơn đã xác nhận: chưa có hợp đồng thì chưa giao được', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/bookings/new');
  const cust = await page.locator('select[name=customer] option', { hasText: 'Khách Đặt B' }).getAttribute('value');
  await page.locator('select[name=customer]').selectOption(cust!);
  await page.getByLabel('Nhận thiết bị', { exact: false }).fill(START);
  await page.getByLabel('Trả thiết bị').fill(END);
  const m = await page.locator('select[name=m1] option', { hasText: 'Sony A7 E2E' }).getAttribute('value');
  await page.locator('select[name=m1]').selectOption(m!);
  await page.locator('input[name=q1]').fill('1');
  await page.getByRole('button', { name: 'Tính giá & kiểm tra lịch' }).click();
  await page.getByRole('button', { name: 'Xác nhận đơn' }).click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}/);
  bookingUrl = page.url().split('?')[0]!;
  await expect(page.getByTestId('deposit-summary')).toContainText('Yêu cầu 1.000.000');
  await expect(page.getByTestId('deposit-summary')).toContainText('thiếu 1.000.000');

  await page.getByRole('link', { name: 'Giao thiết bị' }).click();
  await page.getByTestId('submit-handover').click();
  await expect(page.locator('p[role=alert]')).toContainText('Chưa có hợp đồng');
});

test('lập hợp đồng và ký điện tử: ký trống bị từ chối, ký đủ thì hợp đồng đã ký', async ({ page }) => {
  await login(page, 'owner');
  await page.goto(bookingPath());
  await page.getByRole('button', { name: 'Lập hợp đồng' }).click();
  await expect(page.getByTestId('contract-number')).toHaveText(/^HD-\d{4}-\d{5}$/);
  await expect(page.getByTestId('contract-status')).toHaveText('Chưa ký');
  await page.getByRole('button', { name: 'Xác nhận ký điện tử' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Thiếu chữ ký');
  await scribble(page, 'pad-customerSignature');
  await scribble(page, 'pad-staffSignature');
  await page.getByRole('button', { name: 'Xác nhận ký điện tử' }).click();
  await expect(page.getByText('Đã ký hợp đồng.')).toBeVisible();
  await expect(page.getByTestId('contract-status')).toContainText('Đã ký (điện tử)');
  await expect(page.getByAltText('Chữ ký khách')).toBeVisible();
  // ảnh chữ ký phục vụ qua đường riêng tư, cần đăng nhập
  const src = await page.getByAltText('Chữ ký khách').getAttribute('src');
  const r = await pageFetch(page, src!);
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toBe('image/png');
});

test('trang in hợp đồng có số hợp đồng, thiết bị và số tiền bằng chữ', async ({ page }) => {
  await login(page, 'owner');
  await page.goto(`${bookingPath()}/contract`);
  const doc = page.getByTestId('contract-print');
  await expect(doc).toContainText('HỢP ĐỒNG CHO THUÊ THIẾT BỊ');
  await expect(doc).toContainText('Cửa hàng E2E');
  await expect(doc).toContainText('Sony A7 E2E');
  await expect(doc).toContainText(/Tổng tiền thuê: [\d.]+ đ \(bằng chữ: .*nghìn đồng\)/);
  await expect(doc).toContainText('Một triệu đồng'); // tiền cọc
});

test('chưa đủ cọc thì chưa giao; thu cọc xong thì giao được; QR có số tiền và số hợp đồng', async ({ page }) => {
  await login(page, 'owner');
  await page.goto(`${bookingPath()}/handover`);
  await page.getByTestId('submit-handover').click();
  await expect(page.locator('p[role=alert]')).toContainText('Chưa đủ tiền cọc');

  await page.goto(bookingPath());
  const form = page.getByTestId('payment-form');
  await form.locator('select[name=kind]').selectOption('DEPOSIT');
  await form.locator('input[name=amount]').fill('1.000.000');
  await form.getByRole('button', { name: 'Ghi khoản' }).click();
  await expect(page.getByText('Đã ghi khoản thanh toán.')).toBeVisible();
  await expect(page.getByTestId('deposit-held')).toContainText('1.000.000');
  await expect(page.getByTestId('deposit-summary')).toContainText('đủ');

  // QR: ảnh tải được và nội dung chuyển khoản là số hợp đồng
  const qr = page.getByTestId('qr-box');
  await expect(qr).toContainText('Nội dung: HD');
  const img = qr.locator('img');
  await expect(img).toBeVisible();
  expect(await img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);

  await page.goto(`${bookingPath()}/handover`);
  await page.getByTestId('submit-handover').click();
  await expect(page.getByText(/Đã giao thiết bị/)).toBeVisible();
  await expect(page.getByText('Đang thuê').first()).toBeVisible();
});

test('đã giao: không giao lại được; sổ cọc liệt kê đơn này', async ({ page }) => {
  await login(page, 'owner');
  await page.goto(`${bookingPath()}/handover`);
  await expect(page.getByTestId('receive-form')).toBeVisible(); // đơn đang thuê → trang nhận về, không phải giao
  await expect(page.getByTestId('deliver-form')).toHaveCount(0);
  await page.goto('/deposits');
  const code = await page.goto(bookingPath()).then(() => page.getByRole('heading', { level: 1 }).innerText());
  await page.goto('/deposits');
  await expect(page.getByTestId('deposit-table')).toContainText(code);
});

test('kỹ thuật viên không có quyền giao/nhận hay thu tiền', async ({ page }) => {
  await login(page, 'technician');
  await page.goto(`${bookingPath()}/handover`);
  await expect(page.getByText(/quyền|Không có/i).first()).toBeVisible();
});

test('nhận về: hư hỏng + phí; quyết toán trừ cọc, hoàn phần dư, đóng đơn', async ({ page }) => {
  await login(page, 'owner');
  await page.goto(`${bookingPath()}/handover`);
  await expect(page.getByTestId('receive-form')).toBeVisible();
  // hư hỏng mà không ghi chú → báo lỗi
  await page.locator('select[name=condition_0]').selectOption('DAMAGED');
  await page.getByTestId('submit-handover').click();
  await expect(page.locator('p[role=alert]')).toContainText('cần ghi chú');
  await page.locator('select[name=condition_0]').selectOption('DAMAGED');
  await page.locator('input[name=notes_0]').fill('Trầy ống kính');
  await page.locator('input[name=fee_0]').fill('200000');
  await page.getByTestId('submit-handover').click();
  await expect(page.getByText(/Đã nhận thiết bị về/)).toBeVisible();
  await expect(page.getByText(/Phí phát sinh: Hư hỏng/)).toBeVisible();
  await expect(page.getByTestId('handover-issues')).toContainText('Tốt');

  // tiền thuê (đọc từ đơn, có thể gồm VAT theo cấu hình giá) + 200.000 phí; cọc 1.000.000 → hoàn phần dư
  const digits = async (id: string) => Number((await page.getByTestId(id).innerText()).replace(/\D/g, ''));
  const rent = await digits('booking-total');
  const refund = 1_000_000 - rent - 200_000;
  expect(refund).toBeGreaterThan(0);
  expect(await digits('settle-amount')).toBe(refund);
  await expect(page.getByTestId('settlement')).toContainText('Cần hoàn lại khách');
  await page.getByTestId('close-booking').click();
  await expect(page.locator('p[role=alert]')).toContainText('cần hoàn lại cho khách');

  const form = page.getByTestId('payment-form');
  await form.locator('select[name=kind]').selectOption('REFUND');
  await form.locator('input[name=amount]').fill(String(refund));
  await form.getByRole('button', { name: 'Ghi khoản' }).click();
  await expect(page.getByText('Đã ghi khoản thanh toán.')).toBeVisible();
  await page.getByTestId('close-booking').click();
  await expect(page.getByText('Đã đóng đơn.')).toBeVisible();
  await expect(page.getByText('Đã đóng').first()).toBeVisible();
  await expect(page.getByTestId('payment-form')).toHaveCount(0); // sổ đã khóa
});

test('biên bản giao nhận in được, thấy chênh lệch; sổ cọc không còn đơn này', async ({ page }) => {
  await login(page, 'owner');
  await page.goto(`${bookingPath()}/handover/print`);
  const doc = page.getByTestId('handover-print');
  await expect(doc).toContainText('BIÊN BẢN GIAO NHẬN THIẾT BỊ');
  await expect(doc).toContainText('Hư hỏng');
  await expect(doc).toContainText('Chênh lệch giữa lúc giao và lúc nhận');
  await page.goto('/deposits');
  await expect(page.getByTestId('total-money')).toBeVisible();
  await expect(page.getByTestId('deposit-table')).toHaveCount(0);
});

test('gói Cơ bản có sổ cọc và cấu hình tài chính (ký điện tử chỉ ở gói cao hơn, kiểm ở test dịch vụ)', async ({ page }) => {
  await page.context().clearCookies();
  const base = process.env.E2E_BASIC_URL!;
  await page.goto(`${base}/login`);
  await page.getByPlaceholder('Email').fill('owner@e2e-basic.local');
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sổ cọc' })).toBeVisible();
  await page.goto(`${base}/deposits`);
  await expect(page.getByText('Hiện không giữ cọc')).toBeVisible();
});
