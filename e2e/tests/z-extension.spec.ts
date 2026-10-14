import { test, expect, type Page } from '@playwright/test';
import { createPool, setFeatureOverrides, setTenantExtension } from '@rentpro/db';
import { getExtension, registerExtension } from '@rentpro/extension-sdk';
import demoWeekend from '@rentpro-ext/demo-weekend';
import { E2E_PASSWORD } from '../global-setup';

// Tiến trình test cũng cần registry (setTenantExtension kiểm tra theo định nghĩa extension đã cài).
if (!getExtension(demoWeekend.manifest.code)) registerExtension(demoWeekend);

// Chạy sau cùng: bật extension demo-weekend cho tenant E2E (chính cách cổng quản trị làm) rồi kiểm tra đầu-cuối.
test.use({ baseURL: process.env.E2E_TENANT_URL });
test.describe.configure({ mode: 'serial' });

const actor = { id: '00000000-0000-0000-0000-000000000000', email: 'e2e@rentpro.local' };
const platformUrl = () => process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro';

/** Thứ Bảy đầu tiên của tháng 6/2031 (+ lệch theo giờ chạy để khỏi va chạm giữa các lần), và thứ Ba ngay sau đó. */
const SUFFIX = Number(String(Date.now()).slice(-3)) % 3;
const sat = new Date(Date.UTC(2031, 5, 1));
while (sat.getUTCDay() !== 6) sat.setUTCDate(sat.getUTCDate() + 1);
sat.setUTCDate(sat.getUTCDate() + 7 * (SUFFIX + 1));
const ymd = (d: Date, add = 0) => new Date(d.getTime() + add * 86_400_000).toISOString().slice(0, 10);
const SAT_START = `${ymd(sat)}T08:00`;
const SAT_END = `${ymd(sat, 1)}T08:00`;
const TUE_START = `${ymd(sat, 10)}T08:00`;
const TUE_END = `${ymd(sat, 11)}T08:00`;

async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

async function preview(page: Page, start: string, end: string) {
  await page.goto('/bookings/new');
  const cust = await page.locator('select[name=customer] option', { hasText: 'Khách Đặt A' }).getAttribute('value');
  await page.locator('select[name=customer]').selectOption(cust!);
  await page.getByLabel('Nhận thiết bị', { exact: false }).fill(start);
  await page.getByLabel('Trả thiết bị').fill(end);
  const opt = await page.locator('select[name=m1] option', { hasText: 'Sony A7 E2E' }).getAttribute('value');
  await page.locator('select[name=m1]').selectOption(opt!);
  await page.locator('input[name=q1]').fill('1');
  await page.getByRole('button', { name: 'Tính giá & kiểm tra lịch' }).click();
  await expect(page.getByTestId('booking-preview')).toBeVisible();
}

const money = async (page: Page) => Number((await page.getByTestId('preview-total').innerText()).replace(/\D/g, ''));
const base = { sat: 0, tue: 0 };

test.describe('extension demo-weekend', () => {
  test('chưa bật: không phụ thu, không có trang/báo cáo của extension', async ({ page }) => {
    await login(page, 'owner@e2e.local');
    await preview(page, SAT_START, SAT_END);
    base.sat = await money(page);
    expect(base.sat).toBeGreaterThan(0);
    await expect(page.getByText('Phụ thu cuối tuần')).toHaveCount(0);
    await preview(page, TUE_START, TUE_END);
    base.tue = await money(page);
    await page.goto('/settings');
    await expect(page.getByRole('link', { name: /^Extension/ })).toHaveCount(0);
  });

  test('bật cho cửa hàng: phụ thu 20% cho đơn trọn cuối tuần, đơn ngày thường giữ nguyên', async ({ page }) => {
    const pool = createPool(platformUrl());
    try {
      await setFeatureOverrides(pool, actor, process.env.E2E_TENANT_ID!, { extensions: true });
      await setTenantExtension(pool, actor, process.env.E2E_TENANT_ID!, 'demo-weekend', { enabled: true, config: { uplift: 20, label: 'Phụ thu cuối tuần' } });
    } finally { await pool.end(); }
    await login(page, 'owner@e2e.local');
    await preview(page, SAT_START, SAT_END);
    await expect.poll(() => money(page)).toBeGreaterThan(base.sat);
    await expect(page.getByText(/Phụ thu cuối tuần/).first()).toBeVisible();
    await preview(page, TUE_START, TUE_END);
    expect(await money(page)).toBe(base.tue);
  });

  test('đơn đã chốt giữ nguyên phụ thu; báo cáo và trang của extension hiển thị', async ({ page }) => {
    await login(page, 'owner@e2e.local');
    await preview(page, SAT_START, SAT_END);
    await page.getByRole('button', { name: 'Giữ chỗ', exact: true }).click();
    await expect(page.getByText(/Đã tạo đơn/)).toBeVisible();
    await expect(page.getByText(/Phụ thu cuối tuần/).first()).toBeVisible();

    await page.goto('/reports/ext.demo-weekend.doanh-thu-thu-trong-tuan');
    await expect(page.getByRole('heading', { name: 'Doanh thu theo thứ trong tuần' })).toBeVisible();
    await expect(page.getByText('Chủ nhật').first()).toBeVisible();

    await page.goto('/ext/demo-weekend/cach-tinh');
    await expect(page.getByTestId('ext-title')).toContainText('Phụ thu cuối tuần');
    await expect(page.getByText('20%').first()).toBeVisible();
  });

  test('trang cài đặt Extension liệt kê module; mã lạ cho 404', async ({ page }) => {
    await login(page, 'owner@e2e.local');
    await page.goto('/settings/extensions');
    const li = page.getByTestId('extension-list');
    await expect(li).toContainText('demo-weekend');
    await expect(li).toContainText('Đang chạy');
    const res = await page.goto('/ext/khong-co/trang');
    expect(res?.status()).toBe(404);
  });

  test('nhân viên không có quyền báo cáo tài chính thì bị từ chối; vẫn thấy trang giải thích (booking.view)', async ({ page }) => {
    await login(page, 'staff@e2e.local');
    await page.goto('/reports/ext.demo-weekend.doanh-thu-thu-trong-tuan');
    await expect(page.getByText(/không có quyền|Không tìm thấy|không thuộc/i).first()).toBeVisible();
    await page.goto('/ext/demo-weekend/cach-tinh');
    await expect(page.getByTestId('ext-title')).toBeVisible();
  });

  test('cấu hình lỗi bị cổng quản trị từ chối (dữ liệu service)', async () => {
    const pool = createPool(platformUrl());
    try {
      await expect(setTenantExtension(pool, actor, process.env.E2E_TENANT_ID!, 'demo-weekend', { enabled: true, config: { uplift: 500 } })).rejects.toThrow();
      await setTenantExtension(pool, actor, process.env.E2E_TENANT_ID!, 'demo-weekend', { enabled: false, config: {} });
    } finally { await pool.end(); }
  });

  test('sau khi tắt: phụ thu biến mất cho đơn mới', async ({ page }) => {
    await login(page, 'owner@e2e.local');
    await preview(page, SAT_START, SAT_END);
    expect(await money(page)).toBe(base.sat);
  });
});
