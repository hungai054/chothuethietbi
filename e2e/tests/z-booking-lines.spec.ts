import { test, expect } from '@playwright/test';
import { hashPassword } from '@rentpro/core';
import { changePlan, createPool, createTenant, setTenantStatus } from '@rentpro/db';

// Đơn thuê không bị giới hạn 4 thiết bị: thêm dòng bằng nút, báo giá và xác nhận đủ 6 dòng. Dùng cửa hàng MỚI.
const pool = createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');
test.afterAll(async () => { await pool.end(); });

const STAMP = Date.now();
const SLUG = `e2e-bl-${STAMP}`;
const PASSWORD = 'Mat-khau-E2e-12345';
const actor = { id: '00000000-0000-0000-0000-000000000000', email: 'e2e@rentpro.local' };
const one = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows[0].id as string;
let tenantId = '';

test.use({ baseURL: `http://${SLUG}.localhost:3000` });

test.beforeAll(async () => {
  ({ tenantId } = await createTenant(pool, actor, { slug: SLUG, name: 'Cửa hàng nhiều dòng', planCode: 'basic', ownerEmail: `chu@${SLUG}.local`, ownerName: 'Chủ' }));
  await changePlan(pool, actor, tenantId, 'pro');
  await setTenantStatus(pool, actor, tenantId, 'ACTIVE');
  await pool.query('UPDATE app_user SET password_hash=$2 WHERE tenant_id=$1', [tenantId, await hashPassword(PASSWORD)]);
  const list = await one("INSERT INTO price_list(tenant_id,name,is_default) VALUES ($1,'Giá',true) RETURNING id", [tenantId]);
  for (let i = 1; i <= 6; i++) {
    const m = await one("INSERT INTO equipment_model(tenant_id,name,tracked,stock_qty) VALUES ($1,$2,false,5) RETURNING id", [tenantId, `Phụ kiện số ${i}`]);
    await pool.query('INSERT INTO price_rule(tenant_id,price_list_id,model_id,day_price) VALUES ($1,$2,$3,10000)', [tenantId, list, m]);
  }
  await pool.query("INSERT INTO customer(tenant_id,name,phone) VALUES ($1,'Khách nhiều dòng','0907770001')", [tenantId]);
});

test('thêm dòng thiết bị bằng nút, báo giá và xác nhận đơn 6 dòng', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(`chu@${SLUG}.local`);
  await page.getByPlaceholder('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();

  await page.goto('/bookings/new');
  await expect(page.locator('select[name^=m]')).toHaveCount(4); // mặc định 4 dòng
  await page.getByTestId('add-line').click();
  await page.getByTestId('add-line').click();
  await expect(page.locator('select[name^=m]')).toHaveCount(6);

  await page.locator('select[name=customer]').selectOption({ label: 'Khách nhiều dòng · 0907770001' });
  for (let i = 1; i <= 6; i++) await page.locator(`select[name=m${i}]`).selectOption({ label: `Phụ kiện số ${i} (theo số lượng)` });
  await page.getByRole('button', { name: 'Tính giá & kiểm tra lịch' }).click();

  const preview = page.getByTestId('booking-preview');
  await expect(preview).toBeVisible();
  for (let i = 1; i <= 6; i++) await expect(preview).toContainText(`Phụ kiện số ${i} × 1`);
  await expect(page.getByTestId('preview-total')).toContainText('60.000');
  await expect(page.locator('select[name^=m]')).toHaveCount(6); // sau khi tính giá vẫn giữ đủ 6 dòng

  await preview.getByRole('button', { name: 'Xác nhận đơn', exact: true }).click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}/);
  const rows = (await pool.query("SELECT count(*)::int AS n FROM booking_line l JOIN booking b ON b.id=l.booking_id WHERE b.tenant_id=$1 AND b.status='CONFIRMED'", [tenantId])).rows[0].n;
  expect(rows).toBe(6);
});
