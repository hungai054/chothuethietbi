import { test, expect, type Page } from '@playwright/test';
import { hashPassword } from '@rentpro/core';
import { changePlan, createPool, createTenant, setTenantStatus } from '@rentpro/db';

// API công khai + trang quản lý khóa/webhook, với cửa hàng MỚI gói Doanh nghiệp (không đụng tenant dùng chung).
test.describe.configure({ mode: 'serial' });

const platformUrl = process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro';
const pool = createPool(platformUrl);
test.afterAll(async () => { await pool.end(); });

const STAMP = Date.now();
const SLUG = `e2e-api-${STAMP}`;
const SHOP = `http://${SLUG}.localhost:3000`;
const PASSWORD = 'Mat-khau-E2e-12345';
let modelId = '';
let customerId = '';
let apiKey = '';
let readOnlyKey = '';

const actor = { id: '00000000-0000-0000-0000-000000000000', email: 'e2e@rentpro.local' };
const one = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows[0].id as string;

test.use({ baseURL: SHOP });

test.beforeAll(async () => {
  const { tenantId } = await createTenant(pool, actor, { slug: SLUG, name: 'Cửa hàng API E2E', planCode: 'basic', ownerEmail: `chu@${SLUG}.local`, ownerName: 'Chủ API' });
  await changePlan(pool, actor, tenantId, 'enterprise');
  await setTenantStatus(pool, actor, tenantId, 'ACTIVE');
  await pool.query('UPDATE app_user SET password_hash=$2 WHERE tenant_id=$1', [tenantId, await hashPassword(PASSWORD)]);
  const list = await one("INSERT INTO price_list(tenant_id,name,is_default) VALUES ($1,'Giá',true) RETURNING id", [tenantId]);
  modelId = await one("INSERT INTO equipment_model(tenant_id,name,barcode_prefix) VALUES ($1,'Máy ảnh API','CAM') RETURNING id", [tenantId]);
  await pool.query('INSERT INTO price_rule(tenant_id,price_list_id,model_id,day_price) VALUES ($1,$2,$3,500000)', [tenantId, list, modelId]);
  for (let i = 1; i <= 2; i++) await pool.query('INSERT INTO equipment_unit(tenant_id,model_id,barcode) VALUES ($1,$2,$3)', [tenantId, modelId, `CAM-00000${i}`]);
  customerId = await one("INSERT INTO customer(tenant_id,name,phone) VALUES ($1,'Khách API','0901000111') RETURNING id", [tenantId]);
});

const call = (page: Page, method: string, path: string, key: string | null, body?: unknown) => page.evaluate(async ([m, p, k, b]) => {
  const r = await fetch(p as string, {
    method: m as string, cache: 'no-store',
    headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null), retry: r.headers.get('retry-after') };
}, [method, path, key, body] as const);

async function login(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(`chu@${SLUG}.local`);
  await page.getByPlaceholder('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

async function createKey(page: Page, name: string, scopes: string[]) {
  await page.goto('/settings/api');
  const form = page.getByTestId('key-form');
  await form.getByPlaceholder('VD: Website đặt lịch').fill(name);
  for (const s of scopes) await form.locator(`input[value="${s}"]`).setChecked(true);
  await form.getByRole('button', { name: 'Tạo khóa' }).click();
  const v = form.getByTestId('secret-value');
  await expect(v).toContainText('rp_live_');
  return (await v.textContent())!.trim();
}

test('chủ cửa hàng tạo khóa API: khóa chỉ hiện một lần, danh sách chỉ giữ tiền tố', async ({ page }) => {
  await login(page);
  await page.goto('/settings/api');
  await page.getByTestId('key-form').getByRole('button', { name: 'Tạo khóa' }).click();
  await expect(page.getByTestId('key-form')).toBeVisible(); // thiếu tên: ô required chặn gửi
  apiKey = await createKey(page, 'Website', ['inventory:read', 'customers:read', 'customers:write', 'bookings:read', 'bookings:write', 'availability:read']);
  readOnlyKey = await createKey(page, 'Chỉ xem kho', ['inventory:read']);
  await page.goto('/settings/api');
  const list = page.getByTestId('key-list');
  await expect(list).toContainText('Website');
  await expect(list).toContainText(apiKey.slice(0, 12));
  await expect(page.locator('body')).not.toContainText(apiKey);
  expect((await pool.query('SELECT 1 FROM api_key WHERE key_hash = $1', [apiKey])).rowCount).toBe(0); // DB không giữ khóa gốc
});

test('API: xác thực, phạm vi, tra cứu, tạo khách và tạo đơn', async ({ page }) => {
  await page.goto('/login');
  expect((await call(page, 'GET', '/api/v1/customers', null)).status).toBe(401);
  expect((await call(page, 'GET', '/api/v1/customers', 'rp_live_' + 'x'.repeat(32))).status).toBe(401);
  expect((await call(page, 'GET', '/api/v1/customers', readOnlyKey)).status).toBe(403); // thiếu phạm vi customers:read
  expect((await call(page, 'GET', '/api/v1/khong-co', apiKey)).status).toBe(404);

  const models = await call(page, 'GET', '/api/v1/equipment-models', readOnlyKey);
  expect(models.status).toBe(200);
  expect(models.json.data.map((m: { name: string }) => m.name)).toContain('Máy ảnh API');
  expect((await call(page, 'GET', '/api/v1/equipment-units?pageSize=500', readOnlyKey)).status).toBe(400);

  const created = await call(page, 'POST', '/api/v1/customers', apiKey, { name: 'Khách qua API', phone: '0902000222' });
  expect(created.status).toBe(201);
  const dup = await call(page, 'POST', '/api/v1/customers', apiKey, { name: 'Trùng', phone: '0902000222' });
  expect(dup.status).toBe(400);
  expect(dup.json.error.message).toContain('Số điện thoại');
  expect((await call(page, 'GET', '/api/v1/customers?q=0902000222', apiKey)).json.total).toBe(1);

  const start = '2027-03-01T08:00:00+07:00', end = '2027-03-02T08:00:00+07:00';
  const av = await call(page, 'GET', `/api/v1/availability?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, apiKey);
  expect(av.status).toBe(200);
  expect(av.json.data.find((m: { modelId: string }) => m.modelId === modelId).free).toBe(2);
  expect((await call(page, 'GET', '/api/v1/availability?start=2027-03-01&end=2027-03-02', apiKey)).status).toBe(400); // thiếu giờ/múi giờ

  const item = { modelId, qty: 1 };
  const booking = await call(page, 'POST', '/api/v1/bookings', apiKey, { customerId, start, end, status: 'CONFIRMED', items: [item] });
  expect(booking, JSON.stringify(booking.json)).toMatchObject({ status: 201 });
  expect(booking.json.code).toBeTruthy();
  const detail = await call(page, 'GET', `/api/v1/bookings/${booking.json.id}`, apiKey);
  expect(detail.json.status).toBe('CONFIRMED');
  expect(detail.json.items).toHaveLength(1);
  expect(detail.json.total).toBeGreaterThan(0);
  expect((await call(page, 'GET', '/api/v1/bookings?status=CONFIRMED', apiKey)).json.total).toBe(1);
  expect([400, 409]).toContain((await call(page, 'POST', '/api/v1/bookings', apiKey, { customerId, start, end, status: 'CONFIRMED', items: [{ modelId, qty: 5 }] })).status); // vượt tồn kho

  const free = await call(page, 'GET', `/api/v1/availability?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&modelId=${modelId}`, apiKey);
  expect(free.json.data[0].free).toBe(1);
  // Đơn tạo qua API sinh sự kiện/nhật ký như giao diện
  expect((await pool.query("SELECT 1 FROM audit_log WHERE entity='booking' AND entity_id=$1", [booking.json.id])).rowCount).toBeGreaterThan(0);

  const doc = await call(page, 'GET', '/api/v1/openapi.json', null);
  expect(doc.status).toBe(200);
  expect(Object.keys(doc.json.paths)).toContain('/api/v1/bookings/{id}');
});

test('webhook: thêm địa chỉ, bí mật ký hiện một lần; thu hồi khóa thì API từ chối', async ({ page }) => {
  await login(page);
  await page.goto('/settings/api');
  const form = page.getByTestId('webhook-form');
  await form.getByPlaceholder('https://example.com/hooks/rentpro').fill('http://khong-an-toan.example.com/hook');
  await form.getByRole('button', { name: 'Thêm webhook' }).click();
  await expect(form.locator('p[role=alert]')).toBeVisible();
  await form.getByPlaceholder('https://example.com/hooks/rentpro').fill('https://hooks.example.com/rentpro');
  await form.getByRole('button', { name: 'Thêm webhook' }).click();
  await expect(form.getByTestId('secret-value')).toContainText('whsec_');
  await page.goto('/settings/api');
  await expect(page.getByTestId('webhook-list')).toContainText('https://hooks.example.com/rentpro');
  await page.getByRole('button', { name: 'Tạm dừng' }).click();
  await expect(page.getByTestId('webhook-list')).toContainText('Tạm dừng');

  await page.getByRole('listitem').filter({ hasText: 'Chỉ xem kho' }).getByRole('button', { name: 'Thu hồi' }).click();
  await expect(page.getByTestId('key-list')).toContainText('Đã thu hồi');
  expect((await call(page, 'GET', '/api/v1/equipment-models', readOnlyKey)).status).toBe(401);
  expect((await call(page, 'GET', '/api/v1/equipment-models', apiKey)).status).toBe(200); // khóa khác không bị ảnh hưởng
});
