import { test, expect, type Browser, type Page } from '@playwright/test';
import { payosDataSignature } from '@rentpro/billing';
import { signToken } from '@rentpro/core';
import { SYSTEM_ACTOR, createCoupon, createTenant, createPool, createSubscriptionInvoice, markInvoicePaid, nextOrderCode, sweepSubscriptions } from '@rentpro/db';
import { E2E_ADMIN_SECRET, E2E_PAYOS_CHECKSUM } from '../playwright.config';

// Toàn bộ luồng thương mại với cửa hàng MỚI tự đăng ký (không đụng tenant dùng chung): đăng ký → xác thực email → khởi tạo → mua gói → PayOS → hết hạn → chỉ đọc → gia hạn.
test.use({ baseURL: 'http://localhost:3000' });
test.describe.configure({ mode: 'serial' });

const platformUrl = process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro';
const pool = createPool(platformUrl);
test.afterAll(async () => { await pool.end(); });

const STAMP = Date.now();
const SLUG = `e2e-su-${STAMP}`;
const EMAIL = `chu-${STAMP}@e2e-signup.local`;
const PASSWORD = 'Mat-khau-E2e-12345';
const SHOP = `http://${SLUG}.localhost:3000`;
const COUPON = `KM${String(STAMP).slice(-6)}`;
let tenantId = '';
let invoiceId = '';
let invoiceNumber = '';

const q = async (sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows;

async function loginOwner(page: Page) {
  await page.context().clearCookies();
  await page.goto(`${SHOP}/login`);
  await page.getByPlaceholder('Email').fill(EMAIL);
  await page.getByPlaceholder('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

const postWebhook = (page: Page, raw: string) => page.evaluate(async (body) => {
  const r = await fetch('/api/billing/payos', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  return { status: r.status, json: await r.json() };
}, raw);

const signedHook = (data: Record<string, unknown>) => JSON.stringify({ code: '00', desc: 'success', success: true, data, signature: payosDataSignature(E2E_PAYOS_CHECKSUM, data) });
const paidData = (orderCode: number, amount: number, ref: string) => ({ orderCode, amount, description: 'RP', code: '00', desc: 'Thành công', reference: ref, transactionDateTime: '2027-02-01 10:00:00', currency: 'VND', paymentLinkId: `pl-${ref}` });

test('trang giới thiệu ở tên miền gốc có bảng giá; cửa hàng không có trang này', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('landing')).toBeVisible();
  await expect(page.getByTestId('plan-basic')).toContainText('299.000');
  await expect(page.getByTestId('plan-pro')).toBeVisible();
  await expect(page.getByTestId('plan-enterprise')).toContainText('Liên hệ');
  await page.getByTestId('cta-signup').click();
  await expect(page).toHaveURL(/\/dang-ky/);
  const r = await page.goto(`${SHOP}/gioi-thieu`);
  expect(r?.status()).toBe(404);
});

test('đăng ký: lỗi đầu vào hiện thông báo; đăng ký đúng thì chờ xác thực email', async ({ page }) => {
  await page.goto('/dang-ky');
  await page.getByLabel('Tên cửa hàng').fill('Cho Thuê Máy Ảnh Đà Nẵng');
  await expect(page.getByLabel('Địa chỉ cửa hàng')).toHaveValue('cho-thue-may-anh-da-nang'); // gợi ý từ tên, bỏ dấu
  await page.getByLabel('Địa chỉ cửa hàng').fill('admin');
  await page.getByLabel('Họ tên chủ cửa hàng').fill('Nguyễn Văn An');
  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByLabel(/Mật khẩu/).fill(PASSWORD);
  await page.getByTestId('signup-submit').click();
  await expect(page.locator('p[role=alert]')).toContainText('giữ riêng');

  await page.goto('/dang-ky?plan=pro');
  await page.getByLabel('Tên cửa hàng').fill('Cửa hàng E2E đăng ký');
  await page.getByLabel('Địa chỉ cửa hàng').fill(SLUG);
  await page.getByLabel('Họ tên chủ cửa hàng').fill('Nguyễn Văn An');
  await page.getByLabel('Email', { exact: true }).fill(EMAIL);
  await page.getByLabel(/Mật khẩu/).fill(PASSWORD);
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('signup-sent')).toContainText(EMAIL);
  expect((await q('SELECT 1 FROM tenant WHERE slug=$1', [SLUG])).length).toBe(0); // chưa xác thực thì chưa có cửa hàng
});

test('xác thực email tạo cửa hàng dùng thử; bấm lại không tạo trùng; liên kết sai bị từ chối', async ({ page }) => {
  const mail = (await q("SELECT body FROM platform_email WHERE to_email=$1 AND kind='signup.verify' ORDER BY created_at DESC LIMIT 1", [EMAIL]))[0];
  const link = /(http\S+\/dang-ky\/xac-thuc\?token=[\w-]+)/.exec(mail.body)![1]!;
  await page.goto(link);
  await expect(page.getByTestId('verify-ok')).toBeVisible();
  const t = (await q("SELECT t.id, t.status, p.code FROM tenant t JOIN plan p ON p.id=t.plan_id WHERE t.slug=$1", [SLUG]))[0];
  tenantId = t.id;
  expect(t).toMatchObject({ status: 'TRIAL', code: 'pro' });
  await page.goto(link);
  await expect(page.getByTestId('verify-ok')).toContainText('đã được tạo');
  expect((await q('SELECT count(*)::int AS n FROM tenant WHERE slug=$1', [SLUG]))[0].n).toBe(1);
  await page.goto('/dang-ky/xac-thuc?token=sai-roi');
  await expect(page.getByTestId('verify-error')).toBeVisible();
});

test('chủ cửa hàng mới đăng nhập, làm theo trình khởi tạo: nạp danh mục theo ngành', async ({ page }) => {
  await loginOwner(page);
  await page.goto(`${SHOP}/`);
  await expect(page.getByTestId('onboarding-card')).toBeVisible();
  await page.goto(`${SHOP}/onboarding`);
  await expect(page.getByTestId('onboarding-progress')).toContainText('Đã xong 0/6');
  await page.getByTestId('template-camera').click();
  await expect(page.locator('p[role=status]')).toContainText('Đã thêm');
  await expect(page.getByTestId('onboarding-progress')).toContainText(/Đã xong [2-9]\/6/);
  await page.getByTestId('template-camera').click();
  await expect(page.locator('p[role=status]')).toContainText('đã có sẵn');
  await page.getByLabel('Điện thoại').fill('0909123456');
  await page.getByLabel('Địa chỉ', { exact: true }).fill('12 Lê Lợi');
  await page.getByRole('button', { name: 'Lưu thông tin' }).click();
  await expect(page.locator('p[role=status]')).toContainText('Đã lưu');
  await page.goto(`${SHOP}/inventory/models`);
  await expect(page.getByText('Máy ảnh mirrorless full-frame')).toBeVisible();
});

test('gói dịch vụ: đang dùng thử; tạo hóa đơn có mã giảm giá; hiện PayOS và QR VietQR', async ({ page }) => {
  await createCoupon(pool, SYSTEM_ACTOR, { code: COUPON, percentOff: 10, maxRedemptions: 5 });
  await loginOwner(page);
  await page.goto(`${SHOP}/settings/subscription`);
  await expect(page.getByTestId('subscription-summary')).toContainText('dùng thử');
  await expect(page.getByTestId('usage-list')).toContainText('Người dùng');
  await page.getByTestId('buy-form').locator('select[name=plan]').selectOption('pro');
  await page.getByTestId('buy-form').locator('select[name=cycle]').selectOption('MONTH');
  await page.getByTestId('buy-form').locator('input[name=coupon]').fill('KHONGCO');
  await page.getByRole('button', { name: 'Tạo hóa đơn' }).click();
  await expect(page.locator('p[role=alert]')).toContainText('Không có mã');
  await page.getByTestId('buy-form').locator('input[name=coupon]').fill(COUPON);
  await page.getByTestId('buy-form').locator('select[name=plan]').selectOption('pro');
  await page.getByRole('button', { name: 'Tạo hóa đơn' }).click();
  await expect(page).toHaveURL(/\/settings\/subscription\/pay\/[0-9a-f-]{36}$/);
  invoiceId = page.url().split('/').pop()!;
  await expect(page.getByTestId('invoice-amount')).toContainText('719.100'); // 799.000 − 10%
  invoiceNumber = (await page.getByRole('heading', { level: 1 }).innerText()).replace('Hóa đơn ', '').trim();
  await expect(page.getByTestId('pay-payos')).toBeVisible();
  await expect(page.getByTestId('pay-vietqr')).toBeVisible();
  await expect(page.getByTestId('pay-code')).toHaveText(/^RP[A-Z2-9]{8}$/);
  const qr = await page.evaluate(async (id) => { const r = await fetch(`/settings/subscription/pay/${id}/qr`); return { status: r.status, type: r.headers.get('content-type') }; }, invoiceId);
  expect(qr).toEqual({ status: 200, type: 'image/png' });
});

test('nhân viên không vào được trang gói dịch vụ; hóa đơn của cửa hàng khác không xem được', async ({ page, browser }) => {
  const staff = await browser.newPage();
  await q("INSERT INTO app_user(tenant_id,email,name,password_hash,role) SELECT tenant_id,'nv@e2e-signup.local','NV',password_hash,'STAFF' FROM app_user WHERE tenant_id=$1 AND role='OWNER'", [tenantId]);
  await staff.goto(`${SHOP}/login`);
  await staff.getByPlaceholder('Email').fill('nv@e2e-signup.local');
  await staff.getByPlaceholder('Mật khẩu').fill(PASSWORD);
  await staff.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(staff.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
  await staff.goto(`${SHOP}/settings/subscription`);
  await expect(staff).toHaveURL(/error=/);
  await staff.close();
  // hóa đơn của tenant khác: dùng mã hóa đơn của tenant mẫu E2E
  const other = (await q("SELECT id FROM tenant WHERE id=$1", [process.env.E2E_TENANT_ID]))[0].id;
  const foreign = await createSubscriptionInvoice(pool, SYSTEM_ACTOR, { tenantId: other, planCode: 'basic', cycle: 'MONTH' });
  await loginOwner(page);
  const res = await page.goto(`${SHOP}/settings/subscription/pay/${foreign.id}`);
  expect(res?.status()).toBe(404);
  await q("UPDATE invoice SET status='VOID', note='e2e' WHERE id=$1", [foreign.id]);
});

test('webhook PayOS: chữ ký sai bị từ chối, sai số tiền không kích hoạt, đúng thì kích hoạt, gửi lại không cộng thêm', async ({ page }) => {
  await loginOwner(page);
  const orderCode = await nextOrderCode(pool, invoiceId);
  const bad = JSON.parse(signedHook(paidData(orderCode, 719_100, 'EV-A')));
  bad.signature = 'a'.repeat(64);
  expect((await postWebhook(page, JSON.stringify(bad))).status).toBe(400);
  const wrong = await postWebhook(page, signedHook(paidData(orderCode, 1, 'EV-B')));
  expect(wrong).toMatchObject({ status: 200, json: { ok: false } });
  expect((await q('SELECT status FROM invoice WHERE id=$1', [invoiceId]))[0].status).toBe('OPEN');
  expect((await q("SELECT status FROM tenant WHERE id=$1", [tenantId]))[0].status).toBe('TRIAL');

  const ok = await postWebhook(page, signedHook(paidData(orderCode, 719_100, 'EV-C')));
  expect(ok).toMatchObject({ status: 200, json: { ok: true, already: false } });
  const dup = await postWebhook(page, signedHook(paidData(orderCode, 719_100, 'EV-C')));
  expect(dup.json).toMatchObject({ ok: true, already: true });
  expect((await q("SELECT status FROM tenant WHERE id=$1", [tenantId]))[0].status).toBe('ACTIVE');
  expect((await q("SELECT redeemed FROM coupon WHERE code=$1", [COUPON]))[0].redeemed).toBe(1);

  await page.goto(`${SHOP}/settings/subscription/pay/${invoiceId}`);
  await expect(page.getByTestId('invoice-paid')).toBeVisible();
  await page.goto(`${SHOP}/settings/subscription`);
  await expect(page.getByTestId('subscription-phase')).toContainText('Đang hoạt động');
  await expect(page.getByTestId('invoice-list')).toContainText(invoiceNumber);
  await expect(page.getByTestId('invoice-list')).toContainText('Đã thanh toán');
});

test('đổi gói giữa kỳ: hạ gói áp dụng ngay, số dư trừ vào kỳ sau', async ({ page }) => {
  await loginOwner(page);
  await page.goto(`${SHOP}/settings/subscription`);
  await expect(page.getByTestId('change-plan')).toBeVisible();
  await page.getByTestId('change-plan').getByRole('button', { name: 'Hạ xuống gói này' }).click();
  await expect(page.locator('p[role=status]')).toContainText('Đã hạ gói');
  await expect(page.getByTestId('subscription-summary')).toContainText('Gói Cơ bản');
  await expect(page.getByTestId('subscription-summary')).toContainText('số dư');
  expect((await q('SELECT credit::int AS c FROM subscription WHERE tenant_id=$1', [tenantId]))[0].c).toBeGreaterThan(0);
});

test('hết hạn: quét → chỉ đọc (xem được, không ghi được, có đường gia hạn); thanh toán → mở lại', async ({ page }) => {
  await q("UPDATE subscription SET period_end = now() - interval '10 days', period_start = now() - interval '40 days' WHERE tenant_id=$1", [tenantId]);
  const r = await sweepSubscriptions(pool);
  expect(r.readOnly).toContain(tenantId);
  await loginOwner(page);
  await expect(page.getByTestId('readonly-banner')).toBeVisible();
  await page.goto(`${SHOP}/settings/subscription`);
  await expect(page.getByTestId('subscription-phase')).toContainText('Chỉ đọc');
  // chủ cửa hàng vẫn tải được dữ liệu của mình khi chỉ đọc; tải liên tiếp bị giới hạn
  const download = () => page.evaluate(async () => {
    const r = await fetch('/settings/subscription/export');
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), sig: String.fromCharCode(b[0] ?? 0, b[1] ?? 0), size: b.length };
  });
  const first = await download();
  expect(first).toMatchObject({ status: 200, type: 'application/zip', sig: 'PK' });
  expect(first.disp).toContain(`rentpro-${SLUG}-`);
  expect((await download()).status).toBe(429);
  // dữ liệu vẫn xem được
  await page.goto(`${SHOP}/inventory/models`);
  await expect(page.getByText('Máy ảnh mirrorless full-frame')).toBeVisible();
  // nhưng không ghi được
  await page.goto(`${SHOP}/onboarding`);
  await page.getByTestId('template-event').click();
  await expect(page.locator('p[role=alert]')).toBeVisible();
  expect((await q("SELECT count(*)::int AS n FROM equipment_model WHERE tenant_id=$1 AND name='Loa kéo di động'", [tenantId]))[0].n).toBe(0);

  // gia hạn qua giao diện, thanh toán bằng đường thủ công của quản trị
  await page.goto(`${SHOP}/settings/subscription`);
  await page.getByTestId('buy-form').locator('select[name=plan]').selectOption('basic');
  await page.getByRole('button', { name: 'Tạo hóa đơn' }).click();
  await expect(page).toHaveURL(/\/pay\//);
  const id = page.url().split('/').pop()!;
  await markInvoicePaid(pool, SYSTEM_ACTOR, { invoiceId: id, by: 'e2e', provider: 'MANUAL' });
  expect((await q("SELECT status, locked_by_billing FROM tenant WHERE id=$1", [tenantId]))[0]).toEqual({ status: 'ACTIVE', locked_by_billing: false });
  await page.goto(`${SHOP}/`);
  await expect(page.getByTestId('readonly-banner')).toHaveCount(0);
  await page.goto(`${SHOP}/onboarding`);
  await page.getByTestId('template-event').click();
  await expect(page.locator('p[role=status]')).toContainText('Đã thêm');
});

async function adminPage(browser: Browser) {
  const admin = (await q("INSERT INTO platform_user(email,password_hash,role,totp_enabled) VALUES ($1,'x','SUPER_ADMIN',true) ON CONFLICT (email) DO UPDATE SET totp_enabled=true RETURNING id", [`e2e-admin2-${STAMP}@rentpro.local`]))[0].id;
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addCookies([{ name: 'admin_session', value: signToken({ uid: admin, k: 'session' }, E2E_ADMIN_SECRET, 3600), url: 'http://localhost:3001' }]);
  return { ctx, page: await ctx.newPage() };
}

test('quản trị: xuất dữ liệu cửa hàng; xóa mềm cần gõ đúng địa chỉ; cửa hàng ngừng truy cập; khôi phục được', async ({ browser }) => {
  const slug = `e2e-del-${STAMP}`;
  const { tenantId: id } = await createTenant(pool, SYSTEM_ACTOR, { slug, name: 'Cửa hàng sẽ xóa', planCode: 'basic', ownerEmail: 'o@e2e-del.local', ownerName: 'Chủ' });
  await q("UPDATE tenant SET status='ACTIVE' WHERE id=$1", [id]);
  await q("INSERT INTO customer(tenant_id,name,phone) VALUES ($1,'Khách giữ lại','0900111222')", [id]);
  const { ctx, page } = await adminPage(browser);
  await page.goto(`http://localhost:3001/tenants/${id}`);
  const zip = await page.evaluate(async (tid) => {
    const r = await fetch(`/tenants/${tid}/export`);
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, sig: String.fromCharCode(b[0] ?? 0, b[1] ?? 0) };
  }, id);
  expect(zip).toEqual({ status: 200, sig: 'PK' });

  const form = page.getByTestId('delete-form');
  await form.locator('input[name=reason]').fill('Khách yêu cầu xóa dữ liệu');
  await form.locator('input[name=confirm]').fill('sai-dia-chi');
  await form.getByRole('button', { name: 'Xóa cửa hàng' }).click();
  await expect(page.locator('p[role=alert]').or(page.getByText(/không khớp/))).toBeVisible();
  expect((await q('SELECT status FROM tenant WHERE id=$1', [id]))[0].status).toBe('ACTIVE');

  await page.getByTestId('delete-form').locator('input[name=reason]').fill('Khách yêu cầu xóa dữ liệu');
  await page.getByTestId('delete-form').locator('input[name=confirm]').fill(slug);
  await page.getByTestId('delete-form').getByRole('button', { name: 'Xóa cửa hàng' }).click();
  await expect(page.getByTestId('deleted-list')).toContainText(slug);
  expect((await q('SELECT status FROM tenant WHERE id=$1', [id]))[0].status).toBe('DELETED');
  expect((await q('SELECT count(*)::int AS n FROM customer WHERE tenant_id=$1', [id]))[0].n).toBe(1); // dữ liệu còn nguyên trong thời hạn giữ

  const shop = await ctx.newPage();
  await shop.goto(`http://${slug}.localhost:3000/login`);
  await expect(shop.getByRole('heading', { name: 'Không tìm thấy cửa hàng' })).toBeVisible();

  await page.getByTestId('deleted-list').locator('li', { hasText: slug }).getByRole('button', { name: 'Khôi phục' }).click();
  await expect(page.getByText('Không có cửa hàng nào đã xóa.').or(page.getByTestId('deleted-list'))).toBeVisible();
  expect((await q('SELECT status, deleted_at FROM tenant WHERE id=$1', [id]))[0]).toEqual({ status: 'SUSPENDED', deleted_at: null });
  await ctx.close();
});

test('cổng quản trị: báo cáo MRR, thuê bao của cửa hàng, xác nhận chuyển khoản thủ công', async ({ browser }) => {
  const admin = (await q("INSERT INTO platform_user(email,password_hash,role,totp_enabled) VALUES ($1,'x','SUPER_ADMIN',true) ON CONFLICT (email) DO UPDATE SET totp_enabled=true RETURNING id", [`e2e-admin-${STAMP}@rentpro.local`]))[0].id;
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'admin_session', value: signToken({ uid: admin, k: 'session' }, E2E_ADMIN_SECRET, 3600), url: 'http://localhost:3001' }]);
  const page = await ctx.newPage();
  await page.goto('http://localhost:3001/billing');
  await expect(page.getByRole('heading', { name: 'Thuê bao & doanh thu' })).toBeVisible();
  await expect(page.getByTestId('metrics')).toContainText('MRR');
  await expect(page.getByTestId('by-plan')).toContainText('Chuyên nghiệp');
  await expect(page.getByTestId('coupons')).toContainText(COUPON);

  const open = await createSubscriptionInvoice(pool, SYSTEM_ACTOR, { tenantId, planCode: 'pro', cycle: 'YEAR' });
  await page.goto('http://localhost:3001/billing');
  await expect(page.getByTestId('open-invoices')).toContainText(open.number);
  await page.goto(`http://localhost:3001/tenants/${tenantId}`);
  await expect(page.getByTestId('sub-current')).toContainText('Cơ bản');
  await page.getByTestId(`confirm-${open.number}`).click();
  await expect(page.getByText('Đã lưu.')).toBeVisible();
  const sub = (await q('SELECT p.code, s.cycle FROM subscription s JOIN plan p ON p.id=s.plan_id WHERE s.tenant_id=$1', [tenantId]))[0];
  expect(sub).toEqual({ code: 'pro', cycle: 'YEAR' });
  await expect(page.getByTestId('sub-events')).toContainText('RENEW');
  await ctx.close();
});
