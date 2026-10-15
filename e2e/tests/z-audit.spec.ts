import { test, expect, type Page } from '@playwright/test';
import { hashPassword } from '@rentpro/core';
import { changePlan, createPool, createTenant, setTenantStatus } from '@rentpro/db';

// Nhật ký thao tác (xem, lọc, xuất CSV, phân quyền) và trung tâm thông báo, với cửa hàng MỚI.
test.describe.configure({ mode: 'serial' });

const pool = createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');
test.afterAll(async () => { await pool.end(); });

const STAMP = Date.now();
const SLUG = `e2e-au-${STAMP}`;
const PASSWORD = 'Mat-khau-E2e-12345';
const actor = { id: '00000000-0000-0000-0000-000000000000', email: 'e2e@rentpro.local' };
let tenantId = '';

test.use({ baseURL: `http://${SLUG}.localhost:3000` });

test.beforeAll(async () => {
  ({ tenantId } = await createTenant(pool, actor, { slug: SLUG, name: 'Cửa hàng Audit', planCode: 'basic', ownerEmail: `chu@${SLUG}.local`, ownerName: 'Chủ Audit' }));
  await changePlan(pool, actor, tenantId, 'pro');
  await setTenantStatus(pool, actor, tenantId, 'ACTIVE');
  const hash = await hashPassword(PASSWORD);
  await pool.query('UPDATE app_user SET password_hash=$2 WHERE tenant_id=$1', [tenantId, hash]);
  for (const [role, mail] of [['STAFF', 'nv'], ['MANAGER', 'ql']] as const) {
    await pool.query('INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,$2,$3,$4,$5)', [tenantId, `${mail}@${SLUG}.local`, `Người ${mail}`, hash, role]);
  }
  for (let i = 1; i <= 3; i++) {
    await pool.query("INSERT INTO app_notification(tenant_id,kind,title,body,dedupe_key,created_at) VALUES ($1,'test',$2,'Nội dung',$3, now() - ($4 || ' minutes')::interval)", [tenantId, `Thông báo số ${i}`, `e2e-${i}`, String(i)]);
  }
});

async function login(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

test('thao tác của người dùng hiện trong nhật ký; lọc theo thao tác và từ khóa; xuất CSV an toàn công thức', async ({ page }) => {
  await login(page, `chu@${SLUG}.local`);
  await page.goto('/customers/new');
  await page.getByLabel('Họ tên (*)').fill('=HYPERLINK("http://x")');
  await page.getByLabel('Số điện thoại (*)').fill('0905551234');
  await page.getByRole('button', { name: 'Tạo khách hàng' }).click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}/);

  await page.goto('/settings/audit');
  const table = page.getByTestId('audit-table');
  await expect(table).toContainText('customer.create');
  await expect(table).toContainText('Chủ Audit');

  await page.goto('/settings/audit?action=booking');
  await expect(page.getByTestId('audit-total')).toContainText('0 bản ghi');
  await page.goto('/settings/audit?action=customer&q=HYPERLINK');
  await expect(page.getByTestId('audit-total')).toContainText('1 bản ghi');
  await page.goto('/settings/audit?from=sai-dinh-dang');
  await expect(page.locator('p[role=alert]')).toContainText('YYYY-MM-DD');

  const csv = await page.evaluate(async () => {
    const r = await fetch('/settings/audit/export?action=customer', { cache: 'no-store' });
    const buf = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), bom: Array.from(buf.slice(0, 3)), text: new TextDecoder().decode(buf) };
  });
  expect(csv.status).toBe(200);
  expect(csv.type).toContain('text/csv');
  expect(csv.disp).toContain('nhat-ky-thao-tac.csv');
  expect(csv.bom).toEqual([0xef, 0xbb, 0xbf]); // BOM để Excel đọc đúng tiếng Việt
  expect(csv.text).toContain('"customer.create"');
  expect(csv.text).toContain('HYPERLINK'); // dữ liệu khách nhập vào có thể là công thức...
  expect(csv.text).not.toMatch(/(^|,)"[=+\-@]/m); // ...nhưng không ô nào được bắt đầu bằng ký tự công thức

  // việc xuất cũng để lại dấu vết
  await page.goto('/settings/audit?action=audit.export');
  await expect(page.getByTestId('audit-total')).toContainText('1 bản ghi');
});

test('phân quyền: nhân viên quầy bị từ chối; quản lý xem được nhưng không xuất được', async ({ page }) => {
  await login(page, `nv@${SLUG}.local`);
  await page.goto('/settings/audit');
  await expect(page).toHaveURL(/error=/);
  await expect(page.locator('body')).not.toContainText('customer.create');
  const status = await page.evaluate(async () => (await fetch('/settings/audit/export', { cache: 'no-store' })).status);
  expect(status).toBe(403);

  await login(page, `ql@${SLUG}.local`);
  await page.goto('/settings/audit');
  await expect(page.getByTestId('audit-table')).toBeVisible();
  await expect(page.getByTestId('audit-export')).toHaveCount(0);
  expect(await page.evaluate(async () => (await fetch('/settings/audit/export', { cache: 'no-store' })).status)).toBe(403);
});

test('trung tâm thông báo: đếm chưa đọc, lọc chưa đọc, đánh dấu đã đọc từng cái và tất cả', async ({ page }) => {
  await login(page, `chu@${SLUG}.local`);
  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-all')).toContainText('Tất cả (3)');
  await expect(page.getByTestId('inbox-unread')).toContainText('Chưa đọc (3)');
  await expect(page.getByTestId('inbox-link')).toContainText('3');

  await page.getByTestId('inbox-list').getByRole('listitem').first().getByRole('button', { name: 'Đã đọc' }).click();
  await expect(page.getByTestId('inbox-unread')).toContainText('Chưa đọc (2)');
  await page.getByTestId('inbox-unread').click();
  await expect(page).toHaveURL(/show=unread/);
  await expect(page.getByTestId('inbox-list').getByRole('listitem')).toHaveCount(2);

  await page.getByRole('button', { name: 'Đánh dấu đã đọc tất cả' }).click();
  await expect(page.getByText('Không còn thông báo chưa đọc.')).toBeVisible();
  await expect(page.getByTestId('inbox-all')).toContainText('Tất cả (3)');
  // người dùng khác vẫn chưa đọc (trạng thái đọc theo từng người)
  await login(page, `ql@${SLUG}.local`);
  await page.goto('/inbox');
  await expect(page.getByTestId('inbox-unread')).toContainText('Chưa đọc (3)');
});
