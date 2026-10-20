import { test, expect } from '@playwright/test';
import { signToken } from '@rentpro/core';
import { SYSTEM_ACTOR, createPool, createTenant, setTenantStatus } from '@rentpro/db';
import { E2E_ADMIN_SECRET } from '../playwright.config';

// Chủ cửa hàng quên mật khẩu: quản trị đặt lại ở cổng admin, chủ đăng nhập được bằng mật khẩu tạm, mật khẩu cũ mất hiệu lực.
const pool = createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');
test.afterAll(async () => { await pool.end(); });
test.use({ baseURL: 'http://localhost:3001' });

const STAMP = Date.now();
const SLUG = `e2e-rp-${STAMP}`;
const SHOP = `http://${SLUG}.localhost:3000`;
const OWNER = `chu@${SLUG}.local`;
const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;

async function adminAs(browser: import('@playwright/test').Browser, role: 'SUPER_ADMIN' | 'SALES') {
  const id = (await q("INSERT INTO platform_user(email,password_hash,role,totp_enabled) VALUES ($1,'x',$2,true) ON CONFLICT (email) DO UPDATE SET totp_enabled=true RETURNING id", [`e2e-${role.toLowerCase()}-${STAMP}@rentpro.local`, role]))[0].id as string;
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'admin_session', value: signToken({ uid: id, k: 'session' }, E2E_ADMIN_SECRET, 3600), url: 'http://localhost:3001' }]);
  return { ctx, page: await ctx.newPage() };
}

test('quản trị đặt lại mật khẩu chủ: bắt buộc lý do, hiện mật khẩu tạm một lần, chủ đăng nhập được, mật khẩu cũ hết hiệu lực, có nhật ký', async ({ browser }) => {
  const { tenantId, tempPassword: oldPassword } = await createTenant(pool, SYSTEM_ACTOR, { slug: SLUG, name: 'Cửa hàng quên mật khẩu', planCode: 'basic', ownerEmail: OWNER, ownerName: 'Chủ' });
  await setTenantStatus(pool, SYSTEM_ACTOR, tenantId, 'ACTIVE');
  await q('UPDATE app_user SET active=false WHERE tenant_id=$1', [tenantId]); // mô phỏng tài khoản đang bị khóa

  const { ctx, page } = await adminAs(browser, 'SUPER_ADMIN');
  await page.goto(`/tenants/${tenantId}`);
  const box = page.getByTestId('reset-owner');
  await expect(box).toContainText(OWNER);
  await expect(box).toContainText('đang khóa');
  await box.locator('input[name=reason]').fill('ab'); // quá ngắn: ô required/minLength chặn gửi
  await box.getByRole('button', { name: 'Đặt lại mật khẩu chủ' }).click();
  expect((await q('SELECT 1 FROM platform_audit WHERE tenant_id=$1 AND action=$2', [tenantId, 'tenant.owner_password_reset'])).length).toBe(0);

  await box.locator('input[name=reason]').fill('Chủ quên mật khẩu, đã gọi lại số đăng ký để xác minh');
  await box.getByRole('button', { name: 'Đặt lại mật khẩu chủ' }).click();
  const flash = page.getByTestId('temp-password-flash');
  await expect(flash).toContainText('Đã đặt lại mật khẩu');
  const temp = (await flash.locator('code').textContent())!.trim();
  expect(temp.length).toBeGreaterThanOrEqual(20);
  await expect(page).toHaveURL(/reset=1/);
  expect(page.url()).not.toContain(temp); // mật khẩu không nằm trong URL

  // tải lại: mật khẩu tạm không hiện lại
  await page.goto(`/tenants/${tenantId}`);
  await expect(page.getByTestId('temp-password-flash')).toHaveCount(0);

  expect((await q('SELECT active FROM app_user WHERE tenant_id=$1', [tenantId]))[0].active).toBe(true);
  const audit = (await q('SELECT reason, data FROM platform_audit WHERE tenant_id=$1 AND action=$2', [tenantId, 'tenant.owner_password_reset']))[0];
  expect(audit.reason).toContain('quên mật khẩu');
  expect(JSON.stringify(audit.data)).not.toContain(temp);
  expect((await q("SELECT 1 FROM audit_log WHERE tenant_id=$1 AND action='support.password_reset'", [tenantId])).length).toBe(1);
  await ctx.close();

  // chủ đăng nhập: mật khẩu cũ bị từ chối, mật khẩu tạm vào được
  const owner = await browser.newContext();
  const shop = await owner.newPage();
  await shop.goto(`${SHOP}/login`);
  await shop.getByPlaceholder('Email').fill(OWNER);
  await shop.getByPlaceholder('Mật khẩu').fill(oldPassword);
  await shop.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(shop.getByText('Email hoặc mật khẩu không đúng.')).toBeVisible();
  await shop.getByPlaceholder('Mật khẩu').fill(temp);
  await shop.getByRole('button', { name: 'Đăng nhập' }).click();

  // bị buộc đổi mật khẩu: mọi trang khác đều chuyển về trang đổi mật khẩu
  await expect(shop).toHaveURL(/\/account\/password/);
  await expect(shop.getByTestId('must-change-notice')).toBeVisible();
  await shop.goto(`${SHOP}/settings`);
  await expect(shop).toHaveURL(/\/account\/password/);
  await shop.goto(`${SHOP}/customers`);
  await expect(shop).toHaveURL(/\/account\/password/);
  const search = await shop.evaluate(async () => { const r = await fetch('/api/search?q=abc', { cache: 'no-store' }); return { type: r.headers.get('content-type') ?? '', url: r.url }; });
  expect(search.type).not.toContain('application/json'); // API tìm kiếm cũng bị chặn (chuyển về trang đổi mật khẩu)

  const form = shop.getByTestId('change-password-form');
  const fill = async (cur: string, next: string, confirm: string) => {
    await shop.goto(`${SHOP}/account/password`);
    await form.locator('input[name=current]').fill(cur);
    await form.locator('input[name=next]').fill(next);
    await form.locator('input[name=confirm]').fill(confirm);
    await form.getByRole('button', { name: 'Đổi mật khẩu' }).click();
  };
  const NEW = `Mat-khau-rieng-${STAMP}`;
  await fill(temp, NEW, `${NEW}x`);
  await expect(shop.locator('p[role=alert]')).toContainText('không giống nhau');
  await fill('sai-mat-khau-12345', NEW, NEW);
  await expect(shop.locator('p[role=alert]')).toContainText('hiện tại không đúng');
  await fill(temp, 'yeu', 'yeu');
  await expect(shop.locator('p[role=alert]').or(shop.locator('input[name=next]:invalid'))).toBeVisible();
  await fill(temp, NEW, NEW);
  await expect(shop).toHaveURL(/ok=/);
  await expect(shop.getByRole('link', { name: 'Tổng quan' })).toBeVisible(); // vào được ứng dụng bình thường
  await shop.goto(`${SHOP}/settings`);
  await expect(shop).toHaveURL(/\/settings$/);
  expect((await q('SELECT must_change_password FROM app_user WHERE tenant_id=$1', [tenantId]))[0].must_change_password).toBe(false);

  // mật khẩu tạm không dùng được nữa, mật khẩu riêng dùng được
  const again = await browser.newContext();
  const p2 = await again.newPage();
  await p2.goto(`${SHOP}/login`);
  await p2.getByPlaceholder('Email').fill(OWNER);
  await p2.getByPlaceholder('Mật khẩu').fill(temp);
  await p2.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(p2.getByText('Email hoặc mật khẩu không đúng.')).toBeVisible();
  await p2.getByPlaceholder('Mật khẩu').fill(NEW);
  await p2.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(p2.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
  await expect(p2).not.toHaveURL(/account\/password/);
  // đổi mật khẩu tự nguyện từ thanh đầu trang
  await p2.getByTestId('change-password-link').click();
  await expect(p2).toHaveURL(/\/account\/password/);
  await expect(p2.getByTestId('must-change-notice')).toHaveCount(0);
  await again.close();

  // nhật ký của chính cửa hàng thấy ai đã đặt lại và việc tự đổi
  await shop.goto(`${SHOP}/settings/audit?action=support`);
  await expect(shop.getByTestId('audit-table')).toContainText('support.password_reset');
  await shop.goto(`${SHOP}/settings/audit?action=user.password_change`);
  await expect(shop.getByTestId('audit-total')).toContainText('1 bản ghi');
  await owner.close();
});

test('vai trò không có quyền (SALES) không thấy mục đặt lại và không đặt lại được', async ({ browser }) => {
  const { tenantId } = await createTenant(pool, SYSTEM_ACTOR, { slug: `${SLUG}-b`, name: 'Cửa hàng B', planCode: 'basic', ownerEmail: `chu@${SLUG}-b.local`, ownerName: 'Chủ B' });
  const { ctx, page } = await adminAs(browser, 'SALES');
  await page.goto(`/tenants/${tenantId}`);
  await expect(page.getByRole('heading', { name: 'Cửa hàng B' })).toBeVisible();
  await expect(page.getByTestId('reset-owner')).toHaveCount(0);
  expect((await q('SELECT 1 FROM platform_audit WHERE tenant_id=$1 AND action=$2', [tenantId, 'tenant.owner_password_reset'])).length).toBe(0);
  await ctx.close();
});
