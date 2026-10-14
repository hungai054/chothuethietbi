import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs, ring, type Opts } from './ctx';
import {
  ReadOnlyError, ValidationError, authenticateApiKey, cancelBooking, confirmBooking, createApiKey, createBooking, createCustomer, createModel, createUnits, createWebhook,
  deleteWebhook, dispatchWebhooks, emitEvent, ensureDefaultPriceList, listApiKeys, listDeliveries, listWebhooks, recordPayment, redeliver, revokeApiKey, rotateWebhookSecret,
  setRule, setWebhookActive, withTenantId,
} from '../src';
import { ForbiddenError, hashApiKey, signWebhook, verifyWebhookSignature } from '@rentpro/core';
import { FeatureDisabledError, decryptSecret } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54335);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const URL_OK = 'https://hooks.example.com/rentpro';
const deliveries = async (id: string, event?: string) =>
  (await t.admin.query('SELECT * FROM webhook_delivery WHERE tenant_id=$1 AND ($2::text IS NULL OR event=$2) ORDER BY created_at', [id, event ?? null])).rows;

describe('khóa API', () => {
  it('tạo khóa: trả khóa một lần, DB chỉ giữ băm, danh sách chỉ có tiền tố', async () => {
    const A = await mkTenant(t);
    const k = await as(A, {}, (c) => createApiKey(c, { name: 'Website đặt lịch', scopes: ['bookings:read', 'availability:read'] }));
    expect(k.key).toMatch(/^rp_live_[A-Za-z0-9]{32}$/);
    const row = (await t.admin.query('SELECT key_hash, prefix FROM api_key WHERE id=$1', [k.id])).rows[0];
    expect(row.key_hash).toBe(hashApiKey(k.key));
    expect(JSON.stringify(row)).not.toContain(k.key);
    const list = await as(A, {}, (c) => listApiKeys(c));
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(k.key);
    expect(list[0]).toMatchObject({ name: 'Website đặt lịch', prefix: k.prefix, scopes: ['bookings:read', 'availability:read'], revokedAt: null });
  });

  it('xác thực: khóa đúng → ngữ cảnh cửa hàng (gói, trạng thái, phạm vi); khóa sai/rác → null', async () => {
    const A = await mkTenant(t);
    const k = await as(A, {}, (c) => createApiKey(c, { name: 'k', scopes: ['inventory:read'] }));
    const p = await authenticateApiKey(t.app, k.key);
    expect(p).toMatchObject({ tenantId: A, scopes: ['inventory:read'], status: 'ACTIVE' });
    expect(await authenticateApiKey(t.app, k.key.slice(0, -1) + (k.key.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(await authenticateApiKey(t.app, 'rp_live_short')).toBeNull();
    expect(await authenticateApiKey(t.app, '')).toBeNull();
    expect(await authenticateApiKey(t.app, "rp_live_' OR 1=1 --xxxxxxxxxxxxxxxxxx")).toBeNull();
  });

  it('khóa của cửa hàng A không cho vào cửa hàng B; mỗi khóa chỉ thấy danh sách khóa của cửa hàng mình', async () => {
    const A = await mkTenant(t);
    const B = await mkTenant(t);
    const ka = await as(A, {}, (c) => createApiKey(c, { name: 'a', scopes: ['inventory:read'] }));
    await as(B, {}, (c) => createApiKey(c, { name: 'b', scopes: ['inventory:read'] }));
    expect((await authenticateApiKey(t.app, ka.key))!.tenantId).toBe(A);
    expect((await as(B, {}, (c) => listApiKeys(c))).map((x) => x.name)).toEqual(['b']);
    await expect(as(B, {}, (c) => revokeApiKey(c, ka.id))).rejects.toThrow(/Không tìm thấy/);
  });

  it('thu hồi, hết hạn, cửa hàng bị khóa/xóa đều làm khóa vô hiệu', async () => {
    const A = await mkTenant(t);
    const k1 = await as(A, {}, (c) => createApiKey(c, { name: '1', scopes: ['inventory:read'] }));
    await as(A, {}, (c) => revokeApiKey(c, k1.id));
    expect(await authenticateApiKey(t.app, k1.key)).toBeNull();
    await expect(as(A, {}, (c) => revokeApiKey(c, k1.id))).rejects.toThrow(/Không tìm thấy/);

    const k2 = await as(A, {}, (c) => createApiKey(c, { name: '2', scopes: ['inventory:read'] }));
    await t.admin.query("UPDATE api_key SET expires_at = now() - interval '1 minute' WHERE id=$1", [k2.id]);
    expect(await authenticateApiKey(t.app, k2.key)).toBeNull();

    const k3 = await as(A, {}, (c) => createApiKey(c, { name: '3', scopes: ['inventory:read'] }));
    expect(await authenticateApiKey(t.app, k3.key)).not.toBeNull();
    await t.admin.query("UPDATE tenant SET status='SUSPENDED' WHERE id=$1", [A]);
    expect(await authenticateApiKey(t.app, k3.key)).toBeNull();
    await t.admin.query("UPDATE tenant SET status='DELETED', deleted_at=now() WHERE id=$1", [A]);
    expect(await authenticateApiKey(t.app, k3.key)).toBeNull();
  });

  it('chỉ đọc vẫn xác thực được (để đọc dữ liệu) nhưng trạng thái được trả để chặn ghi', async () => {
    const A = await mkTenant(t, 'p', 'READ_ONLY');
    const k = await t.admin.query("INSERT INTO api_key(tenant_id,name,prefix,key_hash,scopes) VALUES ($1,'x','rp_live_abcdef',$2,'{bookings:write}') RETURNING id", [A, hashApiKey('rp_live_' + 'a'.repeat(32))]);
    expect(k.rowCount).toBe(1);
    expect((await authenticateApiKey(t.app, 'rp_live_' + 'a'.repeat(32)))!.status).toBe('READ_ONLY');
  });

  it('last_used_at chỉ ghi tối đa một lần mỗi phút', async () => {
    const A = await mkTenant(t);
    const k = await as(A, {}, (c) => createApiKey(c, { name: 'k', scopes: ['inventory:read'] }));
    await authenticateApiKey(t.app, k.key);
    const first = (await t.admin.query('SELECT last_used_at FROM api_key WHERE id=$1', [k.id])).rows[0].last_used_at as Date;
    expect(first).not.toBeNull();
    await authenticateApiKey(t.app, k.key);
    expect(((await t.admin.query('SELECT last_used_at FROM api_key WHERE id=$1', [k.id])).rows[0].last_used_at as Date).getTime()).toBe(first.getTime());
  });

  it('đầu vào sai, thiếu quyền, tính năng tắt, chỉ đọc, quá nhiều khóa', async () => {
    const A = await mkTenant(t);
    await expect(as(A, {}, (c) => createApiKey(c, { name: ' ', scopes: ['inventory:read'] }))).rejects.toThrow(/Tên khóa/);
    await expect(as(A, {}, (c) => createApiKey(c, { name: 'x', scopes: [] }))).rejects.toThrow(/ít nhất một/);
    await expect(as(A, {}, (c) => createApiKey(c, { name: 'x', scopes: ['settings:write'] }))).rejects.toThrow(/không hợp lệ/);
    await expect(as(A, {}, (c) => createApiKey(c, { name: 'x', scopes: ['inventory:read'], expiresAt: new Date('2020-01-01') }))).rejects.toThrow(/tương lai/);
    await expect(as(A, { role: 'MANAGER' }, (c) => createApiKey(c, { name: 'x', scopes: ['inventory:read'] }))).resolves.toBeDefined(); // quản lý có settings.manage
    await expect(as(A, { role: 'STAFF' }, (c) => createApiKey(c, { name: 'x', scopes: ['inventory:read'] }))).rejects.toThrow(ForbiddenError);
    await expect(as(A, { off: ['api'] }, (c) => createApiKey(c, { name: 'x', scopes: ['inventory:read'] }))).rejects.toThrow(FeatureDisabledError);
    await expect(as(A, { status: 'READ_ONLY' }, (c) => createApiKey(c, { name: 'x', scopes: ['inventory:read'] }))).rejects.toThrow(ReadOnlyError);
    const B = await mkTenant(t);
    for (let i = 0; i < 20; i++) await as(B, {}, (c) => createApiKey(c, { name: `k${i}`, scopes: ['inventory:read'] }));
    await expect(as(B, {}, (c) => createApiKey(c, { name: 'thứ 21', scopes: ['inventory:read'] }))).rejects.toThrow(/Tối đa 20/);
  });

  it('role ứng dụng không xóa được khóa (chỉ thu hồi) và không đọc được khóa của tenant khác bằng SQL thô', async () => {
    const A = await mkTenant(t);
    const B = await mkTenant(t);
    await as(A, {}, (c) => createApiKey(c, { name: 'a', scopes: ['inventory:read'] }));
    await expect(withTenantId(t.app, A, (db) => db.query('DELETE FROM api_key'))).rejects.toThrow(/permission denied/);
    expect((await withTenantId(t.app, B, (db) => db.query('SELECT * FROM api_key'))).rowCount).toBe(0);
  });
});

describe('webhook: quản lý', () => {
  it('tạo endpoint: bí mật trả một lần, lưu mã hóa (giải mã khớp), danh sách không lộ bí mật', async () => {
    const A = await mkTenant(t);
    const w = await as(A, {}, (c) => createWebhook(c, { url: URL_OK, events: ['booking.created', 'payment.recorded'], description: 'Kế toán' }));
    expect(w.secret).toMatch(/^whsec_[A-Za-z0-9]{32}$/);
    const enc = (await t.admin.query('SELECT secret_enc FROM webhook_endpoint WHERE id=$1', [w.id])).rows[0].secret_enc as string;
    expect(enc).not.toContain(w.secret);
    expect(decryptSecret(enc, ring)).toBe(w.secret);
    const list = await as(A, {}, (c) => listWebhooks(c));
    expect(JSON.stringify(list)).not.toContain(w.secret);
    expect(list[0]).toMatchObject({ url: URL_OK, active: true, events: ['booking.created', 'payment.recorded'], description: 'Kế toán' });
  });

  it('địa chỉ không an toàn bị từ chối (HTTP, nội bộ), sự kiện sai, quá nhiều endpoint; dev được phép khi allowInsecure', async () => {
    const A = await mkTenant(t);
    await expect(as(A, {}, (c) => createWebhook(c, { url: 'http://hooks.example.com/x', events: ['booking.created'] }))).rejects.toThrow(/HTTPS/);
    await expect(as(A, {}, (c) => createWebhook(c, { url: 'https://localhost/x', events: ['booking.created'] }))).rejects.toThrow(/nội bộ/);
    await expect(as(A, {}, (c) => createWebhook(c, { url: 'https://10.0.0.5/x', events: ['booking.created'] }))).rejects.toThrow(/nội bộ/);
    await expect(as(A, {}, (c) => createWebhook(c, { url: URL_OK, events: [] }))).rejects.toThrow(/ít nhất một sự kiện/);
    await expect(as(A, {}, (c) => createWebhook(c, { url: URL_OK, events: ['khong.co'] }))).rejects.toThrow(/không hợp lệ/);
    await expect(as(A, {}, (c) => createWebhook(c, { url: 'http://localhost:9000/x', events: ['booking.created'] }, { allowInsecure: true }))).resolves.toBeDefined();
    for (let i = 0; i < 9; i++) await as(A, {}, (c) => createWebhook(c, { url: `${URL_OK}/${i}`, events: ['booking.created'] }));
    await expect(as(A, {}, (c) => createWebhook(c, { url: `${URL_OK}/11`, events: ['booking.created'] }))).rejects.toThrow(/Tối đa 10/);
  });

  it('đổi bí mật, tắt/bật, xóa; thiếu quyền, tính năng tắt, chỉ đọc bị chặn', async () => {
    const A = await mkTenant(t);
    const w = await as(A, {}, (c) => createWebhook(c, { url: URL_OK, events: ['booking.created'] }));
    const r = await as(A, {}, (c) => rotateWebhookSecret(c, w.id));
    expect(r.secret).not.toBe(w.secret);
    expect(decryptSecret((await t.admin.query('SELECT secret_enc FROM webhook_endpoint WHERE id=$1', [w.id])).rows[0].secret_enc, ring)).toBe(r.secret);
    await as(A, {}, (c) => setWebhookActive(c, w.id, false));
    expect((await as(A, {}, (c) => listWebhooks(c)))[0]).toMatchObject({ active: false, disabledReason: 'Tắt thủ công' });
    await as(A, {}, (c) => setWebhookActive(c, w.id, true));
    await expect(as(A, { role: 'STAFF' }, (c) => listWebhooks(c))).rejects.toThrow(ForbiddenError);
    await expect(as(A, { off: ['api'] }, (c) => listWebhooks(c))).rejects.toThrow(FeatureDisabledError);
    await expect(as(A, { status: 'READ_ONLY' }, (c) => deleteWebhook(c, w.id))).rejects.toThrow(ReadOnlyError);
    await as(A, {}, (c) => deleteWebhook(c, w.id));
    expect(await as(A, {}, (c) => listWebhooks(c))).toHaveLength(0);
    await expect(as(A, {}, (c) => deleteWebhook(c, w.id))).rejects.toThrow(/Không tìm thấy/);
  });

  it('cô lập tenant: không thấy/không sửa được endpoint của cửa hàng khác', async () => {
    const A = await mkTenant(t);
    const B = await mkTenant(t);
    const w = await as(A, {}, (c) => createWebhook(c, { url: URL_OK, events: ['booking.created'] }));
    expect(await as(B, {}, (c) => listWebhooks(c))).toHaveLength(0);
    await expect(as(B, {}, (c) => setWebhookActive(c, w.id, false))).rejects.toThrow(/Không tìm thấy/);
    await expect(as(B, {}, (c) => rotateWebhookSecret(c, w.id))).rejects.toThrow(/Không tìm thấy/);
  });
});

describe('webhook: phát và gửi', () => {
  const setup = async () => {
    const A = await mkTenant(t);
    const a = await as(A, {}, (c) => createWebhook(c, { url: URL_OK, events: ['booking.created', 'booking.cancelled'] }));
    const b = await as(A, {}, (c) => createWebhook(c, { url: `${URL_OK}/b`, events: ['payment.recorded'] }));
    return { A, a, b };
  };

  it('chỉ xếp hàng cho endpoint đang bật và đăng ký đúng sự kiện; tính năng api tắt thì bỏ qua', async () => {
    const { A, a, b } = await setup();
    expect(await as(A, {}, (c) => emitEvent(c, 'booking.created', { x: 1 }))).toBe(1);
    const d = await deliveries(A);
    expect(d).toHaveLength(1);
    expect(d[0].endpoint_id).toBe(a.id);
    expect(d[0].payload).toMatchObject({ type: 'booking.created', data: { x: 1 } });
    expect(d[0].payload.id).toBe(d[0].event_id);
    await as(A, {}, (c) => setWebhookActive(c, a.id, false));
    expect(await as(A, {}, (c) => emitEvent(c, 'booking.created', {}))).toBe(0);
    expect(await as(A, { off: ['api'] }, (c) => emitEvent(c, 'payment.recorded', {}))).toBe(0);
    expect(await as(A, {}, (c) => emitEvent(c, 'payment.recorded', {}))).toBe(1);
    expect((await deliveries(A, 'payment.recorded'))[0].endpoint_id).toBe(b.id);
  });

  it('sự kiện nằm cùng giao dịch: hoàn tác thì sự kiện cũng mất', async () => {
    const { A } = await setup();
    await expect(as(A, {}, async (c) => { await emitEvent(c, 'booking.created', {}); throw new Error('hủy'); })).rejects.toThrow('hủy');
    expect(await deliveries(A)).toHaveLength(0);
  });

  it('gửi thành công: ký đúng HMAC + timestamp, body là payload, ghi SENT; không gửi lại', async () => {
    const { A, a } = await setup();
    await as(A, {}, (c) => emitEvent(c, 'booking.created', { booking: { code: 'DT-1' } }));
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('ok', { status: 200 }); }) as unknown as typeof fetch;
    const now = new Date('2027-03-01T00:00:00Z');
    const r = await as(A, {}, (c) => dispatchWebhooks(c, now, { fetchImpl: fake, resolveHost: async () => ['93.184.216.34'] }));
    expect(r).toMatchObject({ sent: 1, failed: 0, retried: 0 });
    expect(calls).toHaveLength(1);
    const h = calls[0]!.init.headers as Record<string, string>;
    const secret = decryptSecret((await t.admin.query('SELECT secret_enc FROM webhook_endpoint WHERE id=$1', [a.id])).rows[0].secret_enc, ring);
    expect(h['x-rentpro-event']).toBe('booking.created');
    expect(verifyWebhookSignature(secret, Number(h['x-rentpro-timestamp']), String(calls[0]!.init.body), h['x-rentpro-signature']!, Math.floor(now.getTime() / 1000))).toBe(true);
    expect(h['x-rentpro-signature']).toBe(signWebhook(secret, Number(h['x-rentpro-timestamp']), String(calls[0]!.init.body)));
    expect(JSON.parse(String(calls[0]!.init.body)).data.booking.code).toBe('DT-1');
    expect(calls[0]!.init.redirect).toBe('manual');
    const row = (await deliveries(A))[0];
    expect(row).toMatchObject({ status: 'SENT', attempts: 1, last_status: 200 });
    expect((await as(A, {}, (c) => dispatchWebhooks(c, now, { fetchImpl: fake, resolveHost: async () => ['93.184.216.34'] }))).sent).toBe(0);
  });

  it('lỗi thì thử lại theo lịch tăng dần (60s, 5 phút, …), hết 6 lần thì FAILED; giao lại thủ công được', async () => {
    const { A } = await setup();
    await as(A, {}, (c) => emitEvent(c, 'booking.created', {}));
    const fail = (async () => new Response('lỗi', { status: 500 })) as unknown as typeof fetch;
    const deps = { fetchImpl: fail, resolveHost: async () => ['93.184.216.34'] };
    let now = new Date('2027-03-01T00:00:00Z');
    const expectDelays = [60, 300, 1800, 7200, 43_200];
    for (const delay of expectDelays) {
      const r = await as(A, {}, (c) => dispatchWebhooks(c, now, deps));
      expect(r.retried).toBe(1);
      const row = (await deliveries(A))[0];
      expect((row.next_attempt_at as Date).getTime() - now.getTime()).toBe(delay * 1000);
      expect((await as(A, {}, (c) => dispatchWebhooks(c, new Date(now.getTime() + 1000), deps))).retried).toBe(0); // chưa đến hạn
      now = row.next_attempt_at as Date;
    }
    const last = await as(A, {}, (c) => dispatchWebhooks(c, now, deps));
    expect(last.failed).toBe(1);
    expect((await deliveries(A))[0]).toMatchObject({ status: 'FAILED', attempts: 6, last_status: 500 });
    const id = (await deliveries(A))[0].id as string;
    await as(A, {}, (c) => redeliver(c, id));
    expect((await deliveries(A))[0]).toMatchObject({ status: 'PENDING', attempts: 0 });
    await expect(as(A, {}, (c) => redeliver(c, id))).rejects.toThrow(ValidationError);
  });

  it('chuyển hướng không được theo; lỗi mạng và timeout được ghi lại và thử lại', async () => {
    const { A } = await setup();
    await as(A, {}, (c) => emitEvent(c, 'booking.created', {}));
    const redirect = (async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })) as unknown as typeof fetch;
    await as(A, {}, (c) => dispatchWebhooks(c, new Date('2027-03-01T00:00:00Z'), { fetchImpl: redirect, resolveHost: async () => ['93.184.216.34'] }));
    expect((await deliveries(A))[0].last_error).toMatch(/chuyển hướng 302/);
    const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await as(A, {}, (c) => dispatchWebhooks(c, new Date('2027-03-01T00:02:00Z'), { fetchImpl: boom, resolveHost: async () => ['93.184.216.34'] }));
    expect((await deliveries(A))[0]).toMatchObject({ attempts: 2, last_error: 'ECONNREFUSED', last_status: null });
  });

  it('chặn SSRF: host phân giải ra IP nội bộ không bao giờ bị gọi', async () => {
    const { A } = await setup();
    await as(A, {}, (c) => emitEvent(c, 'booking.created', {}));
    let called = false;
    const fake = (async () => { called = true; return new Response('ok'); }) as unknown as typeof fetch;
    for (const ip of [['127.0.0.1'], ['10.0.0.5'], ['169.254.169.254'], ['8.8.8.8', '192.168.1.1'], []]) {
      await as(A, {}, (c) => dispatchWebhooks(c, new Date('2099-01-01T00:00:00Z'), { fetchImpl: fake, resolveHost: async () => ip }));
    }
    expect(called).toBe(false);
    expect((await deliveries(A))[0].last_error).toMatch(/nội bộ/);
  });

  it('endpoint lỗi liên tiếp quá ngưỡng thì tự tắt; thành công đặt lại bộ đếm', async () => {
    const { A, a } = await setup();
    await t.admin.query('UPDATE webhook_endpoint SET consecutive_failures=29 WHERE id=$1', [a.id]);
    await as(A, {}, (c) => emitEvent(c, 'booking.created', {}));
    const fail = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch;
    const r = await as(A, {}, (c) => dispatchWebhooks(c, new Date('2027-03-01T00:00:00Z'), { fetchImpl: fail, resolveHost: async () => ['93.184.216.34'] }));
    expect(r.disabled).toBe(1);
    expect((await as(A, {}, (c) => listWebhooks(c))).find((x) => x.id === a.id)).toMatchObject({ active: false, disabledReason: expect.stringContaining('Tự tắt') });
    await as(A, {}, (c) => setWebhookActive(c, a.id, true));
    expect((await t.admin.query('SELECT consecutive_failures FROM webhook_endpoint WHERE id=$1', [a.id])).rows[0].consecutive_failures).toBe(0);
  });

  it('nhật ký giao hàng chỉ thấy của cửa hàng mình', async () => {
    const { A } = await setup();
    const B = await mkTenant(t);
    await as(A, {}, (c) => emitEvent(c, 'booking.created', {}));
    expect(await as(A, {}, (c) => listDeliveries(c))).toHaveLength(1);
    expect(await as(B, {}, (c) => listDeliveries(c))).toHaveLength(0);
  });
});

describe('sự kiện phát từ nghiệp vụ thật', () => {
  it('tạo/xác nhận/hủy đơn và thu tiền phát đúng sự kiện, dữ liệu gọn không có thông tin nhạy cảm', async () => {
    const A = await mkTenant(t);
    await as(A, {}, (c) => createWebhook(c, { url: URL_OK, events: ['booking.created', 'booking.confirmed', 'booking.cancelled', 'payment.recorded'] }));
    const cam = await as(A, {}, (c) => createModel(c, { name: 'Máy', barcodePrefix: 'CAM' }));
    await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: 2 }));
    const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
    await as(A, {}, (c) => setRule(c, list, cam, { hour: null, day: 500_000, week: null, month: null, minHours: 0 }));
    const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Khách Bí Mật', phone: '0901234567' }));
    const start = new Date('2026-11-02T01:00:00Z');
    const b = await as(A, {}, (c) => createBooking(c, { customerId: cust, start, end: new Date(start.getTime() + 86_400_000), status: 'HOLD', lines: [{ modelId: cam, qty: 1 }] }));
    await as(A, {}, (c) => confirmBooking(c, b.id));
    await as(A, {}, (c) => recordPayment(c, { bookingId: b.id, kind: 'RENT', method: 'CASH', amount: 100_000 }));
    await as(A, {}, (c) => cancelBooking(c, b.id, 'Khách đổi ý'));
    const types = (await deliveries(A)).map((d) => d.payload.type);
    expect(types).toEqual(['booking.created', 'booking.confirmed', 'payment.recorded', 'booking.cancelled']);
    const created = (await deliveries(A, 'booking.created'))[0].payload;
    expect(created.data.booking).toMatchObject({ id: b.id, code: b.code, status: 'HOLD', total: 500_000 });
    const all = JSON.stringify((await deliveries(A)).map((d) => d.payload));
    expect(all).not.toContain('0901234567'); // không lộ số điện thoại
    expect(all).not.toContain('Khách Bí Mật'); // không lộ tên khách
    expect((await deliveries(A, 'booking.cancelled'))[0].payload.data.reason).toBe('Khách đổi ý');
    expect((await deliveries(A, 'payment.recorded'))[0].payload.data.payment).toMatchObject({ bookingId: b.id, kind: 'RENT', amount: 100_000 });
  });

  it('tạo đơn thất bại (hết thiết bị) thì không phát sự kiện nào', async () => {
    const A = await mkTenant(t);
    await as(A, {}, (c) => createWebhook(c, { url: URL_OK, events: ['booking.created'] }));
    const cam = await as(A, {}, (c) => createModel(c, { name: 'Máy', barcodePrefix: 'CAM' }));
    await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: 1 }));
    const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
    await as(A, {}, (c) => setRule(c, list, cam, { hour: null, day: 500_000, week: null, month: null, minHours: 0 }));
    const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Khách K', phone: '0901234568' }));
    const start = new Date('2026-11-02T01:00:00Z');
    await expect(as(A, {}, (c) => createBooking(c, { customerId: cust, start, end: new Date(start.getTime() + 86_400_000), status: 'HOLD', lines: [{ modelId: cam, qty: 5 }] }))).rejects.toThrow();
    expect(await deliveries(A)).toHaveLength(0);
  });
});
