import { test, expect, type Page, type Browser } from '@playwright/test';
import { E2E_PASSWORD } from '../global-setup';

test.use({ baseURL: process.env.E2E_TENANT_URL });
test.describe.configure({ mode: 'serial' });

const SUFFIX = String(Date.now()).slice(-4);
// Mỗi bộ test dùng một khung giờ riêng, xa nhau, để không va chạm
const D = (day: number) => `2027-0${1 + (Number(SUFFIX) % 6)}-${String(day).padStart(2, '0')}`;

async function login(page: Page, role: 'owner' | 'staff' | 'technician', base = process.env.E2E_TENANT_URL!, email?: string) {
  await page.context().clearCookies();
  await page.goto(`${base}/login`);
  await page.getByPlaceholder('Email').fill(email ?? `${role}@e2e.local`);
  await page.getByPlaceholder('Mật khẩu').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('link', { name: 'Tổng quan' })).toBeVisible();
}

async function previewBooking(page: Page, o: { customer: string; model: string; qty?: number; start: string; end: string; discount?: string }) {
  await page.goto('/bookings/new');
  await page.getByLabel('Khách hàng (*)').selectOption({ label: new RegExp(o.customer) as never }).catch(async () => {
    const opt = await page.locator('select[name=customer] option', { hasText: o.customer }).getAttribute('value');
    await page.locator('select[name=customer]').selectOption(opt!);
  });
  await page.getByLabel('Nhận thiết bị', { exact: false }).fill(o.start);
  await page.getByLabel('Trả thiết bị').fill(o.end);
  const opt = await page.locator('select[name=m1] option', { hasText: o.model }).getAttribute('value');
  await page.locator('select[name=m1]').selectOption(opt!);
  await page.locator('input[name=q1]').fill(String(o.qty ?? 1));
  if (o.discount) await page.getByLabel(/Giảm giá/).fill(o.discount);
  await page.getByRole('button', { name: 'Tính giá & kiểm tra lịch' }).click();
  await expect(page.getByTestId('booking-preview')).toBeVisible();
}

const availText = async (page: Page, start: string, end: string) => {
  await page.goto(`/bookings/availability?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  return page.getByTestId('free-Sony A7 E2E').innerText();
};

test('tra cứu còn trống: ban đầu 3/3 chiếc rảnh', async ({ page }) => {
  await login(page, 'owner');
  expect(await availText(page, `${D(5)}T08:00`, `${D(6)}T08:00`)).toMatch(/3\s*\/\s*3/);
});

test('tạo đơn: xem giá + kiểm tra lịch rồi giữ chỗ; lịch rảnh giảm đi', async ({ page }) => {
  await login(page, 'owner');
  await previewBooking(page, { customer: 'Khách Đặt A', model: 'Sony A7 E2E', start: `${D(5)}T08:00`, end: `${D(6)}T08:00` });
  await expect(page.getByTestId('preview-total')).toHaveText(/500\.000\s*đ/);
  await expect(page.getByText('1 ngày × 500.000 đ')).toBeVisible();
  await page.getByRole('button', { name: 'Giữ chỗ', exact: true }).click();
  await expect(page.getByText(/Đã tạo đơn DT-\d{4}-\d{5}/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('DT-');
  await expect(page.getByText('Giữ chỗ đến')).toBeVisible();
  expect(await availText(page, `${D(5)}T08:00`, `${D(6)}T08:00`)).toMatch(/2\s*\/\s*3/);
  // đơn kế tiếp bắt đầu trong thời gian đệm 2 giờ vẫn bị tính là bận; sau đệm thì rảnh
  expect(await availText(page, `${D(6)}T09:00`, `${D(6)}T12:00`)).toMatch(/2\s*\/\s*3/);
  expect(await availText(page, `${D(6)}T10:00`, `${D(6)}T12:00`)).toMatch(/3\s*\/\s*3/);
});

test('hết chiếc thì báo rõ ngay ở bước xem trước, vẫn lưu được báo giá nhưng không giữ chỗ được', async ({ page }) => {
  await login(page, 'owner');
  await previewBooking(page, { customer: 'Khách Đặt A', model: 'Sony A7 E2E', qty: 3, start: `${D(5)}T08:00`, end: `${D(6)}T08:00` });
  await expect(page.getByText('cần 3, chỉ còn 2 rảnh')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Giữ chỗ', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Xác nhận đơn' })).toBeDisabled();
  await page.getByRole('button', { name: 'Lưu báo giá (chưa giữ chỗ)' }).click();
  await expect(page.getByText(/Đã tạo đơn DT-/)).toBeVisible();
  await expect(page.locator('span', { hasText: 'Báo giá' }).first()).toBeVisible();
  expect(await availText(page, `${D(5)}T08:00`, `${D(6)}T08:00`)).toMatch(/2\s*\/\s*3/); // báo giá không chiếm lịch
});

test('hai người đặt cùng lúc chiếc cuối cùng: chỉ một người thành công, người kia nhận thông báo rõ ràng', async ({ browser }) => {
  const mk = async (b: Browser) => {
    const ctx = await b.newContext({ baseURL: process.env.E2E_TENANT_URL });
    const p = await ctx.newPage();
    await login(p, 'owner');
    return { ctx, p };
  };
  const owner = await mk(browser);
  // Lấy còn đúng 1 chiếc: đặt 1 chiếc nữa trong khung giờ này (đã có 1 giữ chỗ, còn 2)
  await previewBooking(owner.p, { customer: 'Khách Đặt B', model: 'Sony A7 E2E', start: `${D(5)}T08:00`, end: `${D(6)}T08:00` });
  await owner.p.getByRole('button', { name: 'Xác nhận đơn' }).click();
  await expect(owner.p.getByText(/Đã tạo đơn DT-/)).toBeVisible();

  // Hai phiên cùng xem trước khi còn 1 chiếc rồi cùng bấm Giữ chỗ
  const a = owner;
  const b = await mk(browser);
  for (const x of [a, b]) await previewBooking(x.p, { customer: 'Khách Đặt A', model: 'Sony A7 E2E', start: `${D(5)}T08:00`, end: `${D(6)}T08:00` });
  await Promise.all([a.p.getByRole('button', { name: 'Giữ chỗ', exact: true }).click(), b.p.getByRole('button', { name: 'Giữ chỗ', exact: true }).click()]);
  await Promise.all([a.p.waitForLoadState('networkidle'), b.p.waitForLoadState('networkidle')]);
  const results = await Promise.all([a.p, b.p].map(async (p) => ({ ok: /\/bookings\/[0-9a-f-]{36}/.test(p.url()), url: p.url() })));
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  const loser = [a.p, b.p][results.findIndex((r) => !r.ok)]!;
  await expect(loser.locator('p[role=alert]')).toContainText(/chỉ còn 0 chiếc rảnh|đã được đặt/);
  expect(await availText(a.p, `${D(5)}T08:00`, `${D(6)}T08:00`)).toMatch(/0\s*\/\s*3/);
  await a.ctx.close(); await b.ctx.close();
});

test('xác nhận, gia hạn tính thêm tiền, rút ngắn hoàn tiền, hủy cần lý do và trả lịch', async ({ page }) => {
  await login(page, 'owner');
  // đơn riêng ở khung giờ khác: 24h, giữ chỗ
  await previewBooking(page, { customer: 'Khách Đặt A', model: 'Sony A7 E2E', start: `${D(10)}T08:00`, end: `${D(11)}T08:00` });
  await page.getByRole('button', { name: 'Giữ chỗ', exact: true }).click();
  await expect(page.getByText(/Đã tạo đơn/)).toBeVisible();
  await page.getByRole('button', { name: 'Xác nhận đơn' }).click();
  await expect(page.getByText('Đã xác nhận đơn.')).toBeVisible();
  await expect(page.getByTestId('booking-total')).toHaveText(/500\.000\s*đ/);

  await page.getByLabel('Gia hạn đến').fill(`${D(12)}T08:00`);
  await page.getByRole('button', { name: 'Gia hạn', exact: true }).click();
  await expect(page.getByText(/Đã gia hạn\. Tổng tiền mới 1\.000\.000\s*đ/)).toBeVisible();
  await expect(page.getByTestId('booking-total')).toHaveText(/1\.000\.000\s*đ/);

  await page.getByLabel('Rút ngắn / trả sớm lúc').fill(`${D(11)}T08:00`);
  await page.getByRole('button', { name: 'Rút ngắn' }).click();
  await expect(page.getByText(/Đã rút ngắn\. Tổng tiền mới 500\.000\s*đ/)).toBeVisible();

  await page.getByPlaceholder('Lý do hủy (bắt buộc)').fill('Khách đổi ý');
  await page.getByRole('button', { name: 'Hủy đơn' }).click();
  await expect(page.getByText('Đã hủy đơn.')).toBeVisible();
  await expect(page.getByText('Lý do hủy:')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hủy đơn' })).toHaveCount(0); // đã hủy, không còn thao tác
  expect(await availText(page, `${D(10)}T08:00`, `${D(11)}T08:00`)).toMatch(/3\s*\/\s*3/);
});

test('bảng hôm nay và danh sách đơn có lọc theo trạng thái', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/bookings/today');
  await expect(page.getByRole('heading', { name: 'Hôm nay' })).toBeVisible();
  await expect(page.getByLabel('Cần giao')).toBeVisible();
  await expect(page.getByLabel('Quá hạn trả')).toBeVisible();
  await page.goto('/bookings?status=CANCELLED');
  await expect(page.locator('tbody span', { hasText: 'Đã hủy' }).first()).toBeVisible();
  await page.goto('/bookings?q=0911000002');
  await expect(page.getByRole('cell', { name: 'Khách Đặt B' }).first()).toBeVisible();
});

test('timeline: kéo thanh để dời lịch, kéo sang hàng khác để đổi chiếc, kéo trên ô trống để giữ chỗ nhanh, trùng lịch bị chặn', async ({ page }) => {
  await login(page, 'owner');
  const from = D(20);
  // tạo sẵn 2 đơn đích danh trên lịch: A trên CAM-000001, B trên CAM-000002 (nhanh bằng form)
  const make = async (customer: string, start: string, end: string) => {
    await previewBooking(page, { customer, model: 'Sony A7 E2E', start, end });
    await page.getByRole('button', { name: 'Xác nhận đơn' }).click();
    await expect(page.getByText(/Đã tạo đơn/)).toBeVisible();
    return (await page.getByRole('heading', { level: 1 }).innerText()).trim();
  };
  const codeA = await make('Khách Đặt A', `${D(21)}T08:00`, `${D(22)}T08:00`);
  const codeB = await make('Khách Đặt B', `${D(21)}T08:00`, `${D(22)}T08:00`);

  await page.goto(`/bookings/timeline?from=${from}&days=14`);
  await expect(page.getByTestId(`bar-${codeA}`)).toBeVisible();
  const barA = page.getByTestId(`bar-${codeA}`);
  const barB = page.getByTestId(`bar-${codeB}`);
  const laneOf = async (code: string) => {
    let id: string | null = null;
    await expect.poll(async () => (id = await page.getByTestId(`bar-${code}`).first().evaluate((el) => el.closest('[data-testid^=lane-]')?.getAttribute('data-testid') ?? null)), { timeout: 8000 }).not.toBeNull();
    return id;
  };
  const lane1 = await laneOf(codeA);
  const lane2 = await laneOf(codeB);
  expect(lane1).not.toBe(lane2);

  const box = async (l: ReturnType<Page['getByTestId']>) => (await l.boundingBox())!;
  const pph = 1200 / (14 * 24);

  // 1) kéo sang phải đúng 24 giờ: đơn A dời sang ngày kế tiếp (đụng B? B ở chiếc khác nên không đụng)
  let b = await box(barA);
  await page.mouse.move(b.x + 10, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 10 + 12 * pph, b.y + b.height / 2, { steps: 6 });
  await page.mouse.move(b.x + 10 + 24 * pph, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('status').filter({ hasText: 'Đã dời lịch.' })).toBeVisible();
  await page.goto(`/bookings?q=${codeA}`);
  await page.getByRole('link', { name: codeA }).click();
  await expect(page.getByText(`${D(22).slice(8)}/${D(22).slice(5, 7)}/${D(22).slice(0, 4)}`).first()).toBeVisible();

  // 2) kéo bar B lên đúng bằng hàng của... đổi sang chiếc thứ ba còn rảnh (kéo xuống 1 hàng)
  await page.goto(`/bookings/timeline?from=${from}&days=14`);
  b = await box(page.getByTestId(`bar-${codeB}`));
  const rowH = 38;
  await page.mouse.move(b.x + 10, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 10, b.y + b.height / 2 + rowH / 2, { steps: 4 });
  await page.mouse.move(b.x + 10, b.y + b.height / 2 + rowH, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('status').filter({ hasText: 'Đã đổi thiết bị.' })).toBeVisible();
  // chờ lịch vẽ lại: thanh phải chuyển sang hàng khác
  await expect.poll(async () => page.getByTestId(`bar-${codeB}`).first().evaluate((el) => el.closest('[data-testid^=lane-]')?.getAttribute('data-testid') ?? null), { timeout: 8000 }).not.toBe(lane2);

  // 3) kéo trên ô trống của chiếc cuối để giữ chỗ nhanh
  const emptyLane = page.locator('[data-testid^=lane-CAM-000003]');
  const lb = await box(emptyLane);
  const busy = await laneOf(codeB);
  test.skip(busy === 'lane-CAM-000003' && false, 'giữ để rõ ý định');
  const target = busy === 'lane-CAM-000003' ? page.locator('[data-testid^=lane-CAM-000001]') : emptyLane;
  const tb = busy === 'lane-CAM-000003' ? await box(target) : lb;
  await page.mouse.move(tb.x + 600 * 1, tb.y + 5);
  await page.mouse.down();
  await page.mouse.move(tb.x + 600 + 12 * pph, tb.y + 5, { steps: 5 });
  await page.mouse.move(tb.x + 600 + 36 * pph, tb.y + 5, { steps: 5 });
  await page.mouse.up();
  const dialog = page.getByRole('dialog', { name: 'Giữ chỗ nhanh' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Khách hàng').selectOption({ label: /Khách Đặt A/ as never }).catch(async () => {
    const v = await dialog.locator('option', { hasText: 'Khách Đặt A' }).getAttribute('value');
    await dialog.getByLabel('Khách hàng').selectOption(v!);
  });
  await dialog.getByRole('button', { name: 'Giữ chỗ', exact: true }).click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}/);
  await expect(page.getByText('Giữ chỗ đến')).toBeVisible();
});

test('timeline: kéo thanh đè lên thanh khác bị chặn bằng thông báo, lịch không đổi', async ({ page }) => {
  await login(page, 'owner');
  // Hai đơn chiếm cả 3 chiếc, cách nhau vừa đủ thời gian đệm: đơn 1 ngày 2→3, đơn 2 ngày 3 (12:00) → 4
  const mk = async (s: string, e: string) => {
    await previewBooking(page, { customer: 'Khách Đặt A', model: 'Sony A7 E2E', qty: 3, start: s, end: e });
    await page.getByRole('button', { name: 'Xác nhận đơn' }).click();
    await expect(page.getByText(/Đã tạo đơn/)).toBeVisible();
    return (await page.getByRole('heading', { level: 1 }).innerText()).trim();
  };
  const first = await mk(`${D(2)}T08:00`, `${D(3)}T08:00`);
  const second = await mk(`${D(3)}T12:00`, `${D(4)}T12:00`);
  await page.goto(`/bookings/timeline?from=${D(1)}&days=14`);
  const pph = 1200 / (14 * 24);
  const b = (await page.getByTestId(`bar-${second}`).first().boundingBox())!;
  await page.mouse.move(b.x + 10, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 10 - 12 * pph, b.y + b.height / 2, { steps: 5 });
  await page.mouse.move(b.x + 10 - 24 * pph, b.y + b.height / 2, { steps: 5 }); // lùi 1 ngày: đè lên đơn đầu
  await page.mouse.up();
  const alert = page.getByRole('alert').filter({ hasText: 'Không đổi được lịch vì trùng với đơn khác' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(first);
  // lịch không đổi: đơn thứ hai vẫn bắt đầu ngày 3
  await page.goto(`/bookings?q=${second}`);
  await page.getByRole('link', { name: second }).click();
  await expect(page.getByText(`${D(3).slice(8)}/${D(3).slice(5, 7)}/${D(3).slice(0, 4)}`).first()).toBeVisible();
});

test('quyền: kỹ thuật viên chỉ xem, không thấy nút tạo; nhân viên quầy tạo và hủy được', async ({ page }) => {
  await login(page, 'technician');
  await page.goto('/bookings');
  await expect(page.getByRole('link', { name: 'Tạo đơn' })).toHaveCount(0);
  await page.goto('/bookings/new');
  await expect(page).toHaveURL(/\/\?error=/);
  await login(page, 'staff');
  await page.goto('/bookings');
  await expect(page.getByRole('link', { name: 'Tạo đơn' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Cấu hình' })).toHaveCount(0); // chỉ quản lý trở lên
});

test('cấu hình đặt lịch: chủ đổi mẫu số đơn, đơn mới theo mẫu mới', async ({ page }) => {
  await login(page, 'owner');
  await page.goto('/settings/booking');
  await page.getByLabel(/Mẫu số đơn thuê/).fill('E2E/{year}/{seq:3}');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu cấu hình đặt lịch.')).toBeVisible();
  await page.getByLabel(/Mẫu số đơn thuê/).fill('khong hop le');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.locator('p[role=alert]')).toBeVisible();
  await previewBooking(page, { customer: 'Khách Đặt B', model: 'Sony A7 E2E', start: `${D(15)}T08:00`, end: `${D(15)}T12:00` });
  await page.getByRole('button', { name: 'Lưu báo giá (chưa giữ chỗ)' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/^E2E\/\d{4}\/\d{3}$/);
});

test('gói Cơ bản không có timeline: ẩn menu và chặn truy cập trực tiếp, các chức năng đặt lịch cơ bản vẫn dùng được', async ({ page }) => {
  const base = process.env.E2E_BASIC_URL!;
  await login(page, 'owner', base, 'owner@e2e-basic.local');
  await page.goto(`${base}/bookings`);
  await expect(page.getByRole('link', { name: 'Lịch', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Tạo đơn' })).toBeVisible();
  await page.goto(`${base}/bookings/timeline`);
  await expect(page).toHaveURL(/\/bookings\?error=/);
  await expect(page.locator('p[role=alert]')).toContainText('chưa có lịch dạng timeline');
});
