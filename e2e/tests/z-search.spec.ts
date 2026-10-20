import { test, expect, type Page } from '@playwright/test';
import { hashPassword } from '@rentpro/core';
import { changePlan, createPool, createTenant, setTenantStatus } from '@rentpro/db';

// Ctrl+K: điều hướng nhanh + tìm kiếm, với hai cửa hàng MỚI (để chứng minh cô lập) và một nhân viên kỹ thuật (không có quyền xem khách).
test.describe.configure({ mode: 'serial' });

const pool = createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');
test.afterAll(async () => { await pool.end(); });

const STAMP = Date.now();
const SLUG = `e2e-sr-${STAMP}`;
const OTHER = `e2e-sro-${STAMP}`;
const PASSWORD = 'Mat-khau-E2e-12345';
const actor = { id: '00000000-0000-0000-0000-000000000000', email: 'e2e@rentpro.local' };
let bookingId = '';
let bookingCode = '';
const one = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows[0].id as string;

test.use({ baseURL: `http://${SLUG}.localhost:3000` });

async function mkShop(slug: string, tag: string) {
  const { tenantId } = await createTenant(pool, actor, { slug, name: `Cửa hàng ${tag}`, planCode: 'basic', ownerEmail: `chu@${slug}.local`, ownerName: 'Chủ' });
  await changePlan(pool, actor, tenantId, 'pro');
  await setTenantStatus(pool, actor, tenantId, 'ACTIVE');
  const hash = await hashPassword(PASSWORD);
  await pool.query('UPDATE app_user SET password_hash=$2 WHERE tenant_id=$1', [tenantId, hash]);
  const model = await one("INSERT INTO equipment_model(tenant_id,name,barcode_prefix,brand) VALUES ($1,$2,'CAM','Sony') RETURNING id", [tenantId, `Máy ảnh ${tag}`]);
  await pool.query('INSERT INTO equipment_unit(tenant_id,model_id,barcode) VALUES ($1,$2,$3)', [tenantId, model, `CAM-${tag}-1`]);
  const cust = await one("INSERT INTO customer(tenant_id,name,phone) VALUES ($1,$2,'0903334444') RETURNING id", [tenantId, `Khách ${tag}`]);
  return { tenantId, cust, hash };
}

test.beforeAll(async () => {
  const a = await mkShop(SLUG, 'Zulu');
  await pool.query("INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,$2,'Kỹ thuật','x','TECHNICIAN')", [a.tenantId, `kt@${SLUG}.local`]);
  await pool.query('UPDATE app_user SET password_hash=$2 WHERE tenant_id=$1', [a.tenantId, a.hash]);
  bookingCode = `DT-SR-${STAMP}`;
  bookingId = await one(
    `INSERT INTO booking(tenant_id,code,customer_id,status,starts_at,ends_at,total) VALUES ($1,$2,$3,'QUOTE','2027-05-01T01:00:00Z','2027-05-02T01:00:00Z',500000) RETURNING id`,
    [a.tenantId, bookingCode, a.cust]);
  await mkShop(OTHER, 'Yankee');
});

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

test('Ctrl+K mở bảng, gõ tên trang rồi Enter thì chuyển trang; Esc đóng', async ({ page }) => {
  await login(page, `chu@${SLUG}.local`);
  await page.keyboard.press('Control+k');
  const dlg = page.getByTestId('palette');
  await expect(dlg).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Từ khóa' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Từ khóa' }).fill('khach'); // không dấu vẫn khớp "Khách hàng"
  await expect(page.getByTestId('palette-item').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/customers/);
  await expect(dlg).toBeHidden();
});

test('tìm đơn, khách, thiết bị; chọn kết quả mở đúng trang; không thấy dữ liệu cửa hàng khác', async ({ page }) => {
  await login(page, `chu@${SLUG}.local`);
  await page.getByTestId('palette-open').click();
  const box = page.getByRole('combobox', { name: 'Từ khóa' });

  await box.fill('Zulu');
  const list = page.getByTestId('palette-list');
  await expect(list).toContainText('Khách Zulu');
  await expect(list).toContainText('•••4444'); // số điện thoại bị che
  await expect(list).not.toContainText('0903334444');
  await expect(list).toContainText('Máy ảnh Zulu');

  await box.fill('Yankee');
  await expect(page.getByTestId('palette-status')).toContainText('Không có kết quả');
  await expect(list).not.toContainText('Yankee');

  await box.fill(bookingCode);
  await page.getByTestId('palette-item').filter({ hasText: bookingCode }).click();
  await expect(page).toHaveURL(new RegExp(`/bookings/${bookingId}$`));

  await page.getByTestId('palette-open').click();
  await page.getByRole('combobox', { name: 'Từ khóa' }).fill('CAM-Zulu');
  await page.keyboard.press('ArrowDown'); // chỉ để thử phím mũi tên không gây lỗi
  await page.getByTestId('palette-item').filter({ hasText: 'CAM-Zulu-1' }).click();
  await expect(page).toHaveURL(/\/inventory\/units\//);
});

test('nhân viên kỹ thuật (không có quyền xem khách) không có nhóm khách trong kết quả; API chưa đăng nhập bị từ chối', async ({ page }) => {
  await login(page, `kt@${SLUG}.local`);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Từ khóa' }).fill('Zulu');
  await expect(page.getByTestId('palette-list')).toContainText('Máy ảnh Zulu');
  // Kỹ thuật viên có quyền xem đơn (như trang Đơn thuê) nhưng không có nhóm "Khách hàng"
  await expect(page.getByTestId('palette-item').filter({ hasText: 'Khách hàng' })).toHaveCount(0);
  const api = await page.evaluate(async () => (await (await fetch('/api/search?q=Zulu', { cache: 'no-store' })).json()));
  expect(api.customers).toEqual([]);

  await page.context().clearCookies();
  const anon = await page.evaluate(async () => (await fetch('/api/search?q=Zulu', { cache: 'no-store' })).status);
  expect(anon).toBe(401);
});
