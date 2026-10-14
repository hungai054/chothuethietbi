import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, ring, runAs, type Opts } from './ctx';
import {
  ReadOnlyError, createBooking, createCustomer, createModel, createUnits, dispatchQueued, ensureDefaultPriceList, getNotifySettings, listInbox, listNotifications, markInboxRead,
  pruneJobRuns, rawNotifySettings, resendNotification, runAllJobs, runTenantJobs, listRunnableTenants, scanReminders, sendTestNotification, setRule, updateNotifySettings, withTenantId,
  type NotifyDeps, type NotifySettingsInput,
} from '../src';
import { ConsoleProvider, type NotificationProvider, type OutgoingMessage, type ProviderConfig, type SendResult } from '@rentpro/notifications';
import { DEFAULT_QUIET, DEFAULT_REMINDERS, ForbiddenError, verifyToken } from '@rentpro/core';
import { FEATURE_KEYS, FeatureDisabledError } from '@rentpro/tenancy';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54337);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
  await t.admin.query("INSERT INTO plan(code,name,features,limits) VALUES ('full','Full',$1,'{}')", [JSON.stringify(Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])))]);
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const SECRET = 'bi-mat-ky-lien-ket-thanh-toan-du-dai-0123456789';
const H = 3_600_000;
const D = 24 * H;
const NOW = new Date('2027-03-10T10:00:00+07:00'); // giữa ngày, ngoài giờ nghỉ

/** Nhà cung cấp giả: ghi lại tin, trả kết quả theo kịch bản. */
class Fake implements NotificationProvider {
  readonly name = 'fake';
  sent: OutgoingMessage[] = [];
  results: SendResult[] = [];
  constructor(readonly channel: 'sms' | 'email' | 'zalo') {}
  async send(m: OutgoingMessage): Promise<SendResult> {
    this.sent.push(m);
    return this.results.shift() ?? { ok: true, providerId: `f${this.sent.length}` };
  }
}
function fakes() {
  const by = { sms: new Fake('sms'), email: new Fake('email'), zalo: new Fake('zalo') };
  const configs: ProviderConfig[] = [];
  const deps: NotifyDeps = {
    shared: { sms: { channel: 'sms', mode: 'speedsms', accessToken: 'shared-token' }, email: { channel: 'email', mode: 'console' } },
    build: (c) => { configs.push(c); return c.mode === 'console' && c.channel !== 'email' ? new ConsoleProvider(c.channel) : by[c.channel]; },
  };
  return { by, deps, configs };
}

const base = (): NotifySettingsInput => ({
  channels: ['sms', 'email'], quietHours: DEFAULT_QUIET, reminders: DEFAULT_REMINDERS, templates: {},
  email: { mode: 'console' }, sms: { mode: 'console' }, zalo: { mode: 'console' },
});

async function shop(plan = 'full') {
  const A = await mkTenant(t, plan);
  const cam = await as(A, {}, (c) => createModel(c, { name: 'Sony A7', barcodePrefix: 'CAM' }));
  await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: 6 }));
  const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
  await as(A, {}, (c) => setRule(c, list, cam, { hour: 100_000, day: 500_000, week: 2_500_000, month: null, minHours: 0 }));
  const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Nguyễn Văn An', phone: '0901234567', email: 'an@example.vn' }));
  return { A, cam, cust };
}
type Shop = Awaited<ReturnType<typeof shop>>;
let slot = 0;

/** Tạo đơn rồi ép trạng thái và mốc thời gian bằng SQL quản trị (lịch không ảnh hưởng tới việc quét nhắc). */
async function bk(s: Shop, over: { status: string; ends?: Date; hold?: Date | null; returned?: Date; customer?: string }) {
  const day = ++slot * 3;
  const { id } = await as(s.A, {}, (c) => createBooking(c, {
    customerId: over.customer ?? s.cust, lines: [{ modelId: s.cam, qty: 1 }], start: new Date(NOW.getTime() + (200 + day) * D), end: new Date(NOW.getTime() + (201 + day) * D), status: 'CONFIRMED',
  }));
  await t.admin.query('UPDATE booking SET status=$2, starts_at=$3, ends_at=$4, hold_expires_at=$5, returned_at=$6 WHERE id=$1', [
    id, over.status, new Date((over.ends ?? NOW).getTime() - D), over.ends ?? NOW, over.hold ?? null, over.returned ?? null]);
  return id;
}
const log = async (A: string, where = '1=1') => (await t.admin.query(`SELECT * FROM notification_log WHERE tenant_id=$1 AND ${where} ORDER BY created_at, id`, [A])).rows;

describe('cấu hình thông báo', () => {
  it('mặc định giả lập; lưu cấu hình, khóa được mã hóa và không bao giờ trả lại', async () => {
    const s = await shop();
    const v0 = await as(s.A, {}, (c) => getNotifySettings(c));
    expect(v0).toMatchObject({ channels: ['sms', 'email'], sms: { mode: 'console', hasApiKey: false }, email: { mode: 'console' } });
    expect(v0.customTemplates).toEqual([]);
    await as(s.A, {}, (c) => updateNotifySettings(c, {
      ...base(), channels: ['zalo', 'sms', 'email'], templates: { DUE: 'Đơn {ma_don} đã đến hạn.' },
      sms: { mode: 'esms', apiKey: 'API-KEY-123', secret: 'SECRET-456', brandname: 'SHOP' }, email: { mode: 'smtp', host: 'smtp.x.vn', port: 587, from: 'shop@x.vn', user: 'u', password: 'smtp-pass' },
      zalo: { mode: 'zns', oaId: '1', templateId: '9', accessToken: 'ZALO-TOKEN' },
    }));
    const raw = JSON.stringify((await t.admin.query('SELECT settings FROM tenant WHERE id=$1', [s.A])).rows[0].settings);
    for (const secret of ['API-KEY-123', 'SECRET-456', 'smtp-pass', 'ZALO-TOKEN']) expect(raw).not.toContain(secret);
    const v = await as(s.A, {}, (c) => getNotifySettings(c));
    expect(v).toMatchObject({ sms: { mode: 'esms', hasApiKey: true, hasSecret: true, brandname: 'SHOP' }, email: { hasPassword: true, host: 'smtp.x.vn' }, zalo: { hasToken: true, templateId: '9' }, customTemplates: ['DUE'] });
    expect(JSON.stringify(v)).not.toContain('API-KEY-123');
    // để trống ô bí mật khi sửa tiếp thì giữ khóa cũ
    await as(s.A, {}, (c) => updateNotifySettings(c, { ...base(), channels: ['sms'], sms: { mode: 'esms', brandname: 'MOI' }, email: { mode: 'console' }, zalo: { mode: 'console' } }));
    expect(await as(s.A, {}, (c) => getNotifySettings(c))).toMatchObject({ sms: { hasApiKey: true, hasSecret: true, brandname: 'MOI' } });
    // và nhà cung cấp được dựng bằng khóa đã giải mã
    const f = fakes();
    await as(s.A, {}, (c) => sendTestNotification(c, 'sms', '0912345678', f.deps));
    expect(f.configs.at(-1)).toMatchObject({ channel: 'sms', mode: 'esms', apiKey: 'API-KEY-123', secretKey: 'SECRET-456', brandname: 'MOI' });
  });

  it('đầu vào sai báo tiếng Việt: thiếu thông tin SMTP/khóa, mẫu có biến lạ, khung giờ sai, kênh ngoài gói', async () => {
    const s = await shop();
    const upd = (o: Partial<NotifySettingsInput>, opts: Opts = {}) => as(s.A, opts, (c) => updateNotifySettings(c, { ...base(), ...o }));
    await expect(upd({ email: { mode: 'smtp', host: 'h' } })).rejects.toThrow(/SMTP cần máy chủ, cổng và địa chỉ gửi/);
    await expect(upd({ email: { mode: 'smtp', host: 'h', port: 25, from: 'khong-hop-le' } })).rejects.toThrow(/Địa chỉ gửi email/);
    await expect(upd({ sms: { mode: 'esms' } })).rejects.toThrow(/ApiKey và SecretKey/);
    await expect(upd({ sms: { mode: 'speedsms' } })).rejects.toThrow(/Access Token/);
    await expect(upd({ zalo: { mode: 'zns', accessToken: 'x' } })).rejects.toThrow(/mã mẫu tin/);
    await expect(upd({ templates: { DUE: 'Chào {xyz}' } })).rejects.toThrow(/Biến không hợp lệ: \{xyz\}/);
    await expect(upd({ quietHours: { enabled: true, start: '25:00', end: '07:00' } })).rejects.toThrow(/HH:MM/);
    await expect(upd({ reminders: { ...DEFAULT_REMINDERS, beforeDueHours: 0 } })).rejects.toThrow();
    await expect(upd({ channels: ['sms'] }, { off: ['notify.sms'] })).rejects.toThrow(/không có kênh SMS/);
    await expect(upd({ zalo: { mode: 'zns', accessToken: 'x', templateId: '1' } }, { off: ['notify.zalo'] })).rejects.toThrow(/không có Zalo/);
    await expect(upd({ sms: { mode: 'esms', apiKey: 'a', secret: 'b' } }, { ring: undefined, perms: ['settings.manage'] })).resolves.toBeUndefined(); // vẫn có khóa mặc định của test
  });

  it('phân quyền, chỉ đọc, cô lập tenant', async () => {
    const s = await shop();
    const B = await shop();
    await expect(as(s.A, { role: 'STAFF' }, (c) => updateNotifySettings(c, base()))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { role: 'STAFF' }, (c) => getNotifySettings(c))).rejects.toThrow(ForbiddenError);
    await expect(as(s.A, { status: 'READ_ONLY' }, (c) => updateNotifySettings(c, base()))).rejects.toThrow(ReadOnlyError);
    await as(s.A, {}, (c) => updateNotifySettings(c, { ...base(), channels: ['email'] }));
    expect((await as(B.A, {}, (c) => rawNotifySettings(c))).channels).toEqual(['sms', 'email']); // tenant khác không bị ảnh hưởng
  });
});

describe('quét nhắc nhở', () => {
  it('sắp đến hạn: tạo một tin với biến đã thay; quét lại không tạo trùng', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    const id = await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 10 * H) });
    const r1 = await as(s.A, {}, (c) => scanReminders(c, NOW));
    expect(r1).toMatchObject({ queued: 1, skipped: 0 });
    const r2 = await as(s.A, {}, (c) => scanReminders(c, new Date(NOW.getTime() + 30 * 60_000)));
    expect(r2.queued).toBe(0);
    const rows = await log(s.A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'BEFORE_DUE', channel: 'sms', recipient: '0901234567', status: 'QUEUED', booking_id: id, idempotency_key: `BEFORE_DUE:${id}:1` });
    expect(rows[0].body).toMatch(/^Chào Nguyễn Văn An, đơn thuê .+ \(Sony A7\) sẽ đến hạn trả lúc .+\. Vui lòng trả đúng hạn\./);
    expect(rows[0].body).not.toMatch(/[{}]/);
  });

  it('hai lần quét đồng thời vẫn chỉ một tin', async () => {
    const s = await shop();
    await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 2 * H) });
    await Promise.all([1, 2, 3].map(() => as(s.A, {}, (c) => scanReminders(c, NOW))));
    expect(await log(s.A)).toHaveLength(1);
  });

  it('chọn kênh theo thứ tự ưu tiên và dữ liệu liên hệ; khách không liên hệ được thì ghi "bỏ qua" kèm lý do', async () => {
    const s = await shop();
    const noPhone = await as(s.A, {}, (c) => createCustomer(c, { name: 'Chỉ có email', phone: '0912000001', email: 'x@y.vn' }));
    await t.admin.query("UPDATE customer SET phone='abc1' WHERE id=$1", [noPhone]);
    const none = await as(s.A, {}, (c) => createCustomer(c, { name: 'Không liên hệ', phone: '0912000002' }));
    await t.admin.query("UPDATE customer SET phone='abc2' WHERE id=$1", [none]);
    await as(s.A, {}, (c) => updateNotifySettings(c, { ...base(), channels: ['sms', 'email'] }));
    const soon = new Date(NOW.getTime() + 5 * H);
    const a = await bk(s, { status: 'ACTIVE', ends: soon, customer: noPhone });
    const b = await bk(s, { status: 'ACTIVE', ends: soon, customer: none });
    const c3 = await bk(s, { status: 'ACTIVE', ends: soon });
    await as(s.A, {}, (c) => scanReminders(c, NOW));
    const by = Object.fromEntries((await log(s.A)).map((r) => [r.booking_id, r]));
    expect(by[a]).toMatchObject({ channel: 'email', recipient: 'x@y.vn', status: 'QUEUED' });
    expect(by[b]).toMatchObject({ status: 'SKIPPED', recipient: '-' });
    expect(by[b].error).toMatch(/chưa có số điện thoại\/email phù hợp/);
    expect(by[c3]).toMatchObject({ channel: 'sms', status: 'QUEUED' });
    await expect(as(s.A, {}, (c) => resendNotification(c, by[b].id))).rejects.toThrow(/chưa có người nhận/);
  });

  it('kênh ngoài gói bị bỏ qua khi chọn kênh', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, { ...base(), channels: ['sms', 'email'] }));
    await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 5 * H) });
    await as(s.A, { off: ['notify.sms'] }, (c) => scanReminders(c, NOW));
    expect((await log(s.A))[0]).toMatchObject({ channel: 'email', recipient: 'an@example.vn' });
  });

  it('đến hạn, quá hạn lặp theo chu kỳ (có cảnh báo cho quản lý), dừng sau số lần tối đa', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    const end = new Date(NOW.getTime() - 60_000);
    const id = await bk(s, { status: 'ACTIVE', ends: end });
    await as(s.A, {}, (c) => scanReminders(c, NOW));
    expect((await log(s.A)).map((r) => r.event)).toEqual(['DUE']);
    for (const n of [1, 2, 3, 4]) await as(s.A, {}, (c) => scanReminders(c, new Date(end.getTime() + n * D + 60_000)));
    expect((await log(s.A)).map((r) => r.idempotency_key)).toEqual([`DUE:${id}:1`, `OVERDUE:${id}:1`, `OVERDUE:${id}:2`, `OVERDUE:${id}:3`]);
    const mgr = await as(s.A, { role: 'MANAGER' }, (c) => listInbox(c));
    expect(mgr.items.map((i) => i.title)).toEqual(expect.arrayContaining([expect.stringMatching(/quá hạn trả/)]));
    expect(mgr.items.filter((i) => i.kind === 'OVERDUE')).toHaveLength(3);
    expect((await as(s.A, { role: 'STAFF' }, (c) => listInbox(c))).items).toEqual([]); // nhân viên quầy không thấy cảnh báo của quản lý
  });

  it('giữ chỗ sắp hết hạn và công nợ sau khi nhận lại (kèm liên kết thanh toán)', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    const hold = await bk(s, { status: 'HOLD', hold: new Date(NOW.getTime() + 3 * H) });
    const debt = await bk(s, { status: 'RETURNED', returned: new Date(NOW.getTime() - 2 * D) });
    await t.admin.query('UPDATE booking SET total=500000 WHERE id=$1', [debt]);
    const farHold = await bk(s, { status: 'HOLD', hold: new Date(NOW.getTime() + 30 * H) });
    await as(s.A, {}, (c) => scanReminders(c, NOW, { payLink: (id) => `https://shop.vn/pay/${id}` }));
    const rows = await log(s.A);
    expect(rows.map((r) => `${r.event}:${r.booking_id}`).sort()).toEqual([`DEBT:${debt}`, `HOLD_EXPIRING:${hold}`].sort());
    expect(rows.find((r) => r.event === 'DEBT').body).toContain(`500.000 đ`);
    expect(rows.find((r) => r.event === 'DEBT').body).toContain(`https://shop.vn/pay/${debt}`);
    expect(rows.find((r) => r.booking_id === farHold)).toBeUndefined();
    // công nợ đã thu đủ thì không nhắc
    await t.admin.query("INSERT INTO payment(tenant_id,booking_id,kind,method,amount) VALUES ($1,$2,'RENT','CASH',500000)", [s.A, debt]);
    await as(s.A, {}, (c) => scanReminders(c, new Date(NOW.getTime() + 8 * D)));
    expect((await log(s.A, `event='DEBT'`))).toHaveLength(1);
  });

  it('tắt từng loại nhắc, đổi mẫu tin; đơn đang xác nhận hoặc đã đóng không bị nhắc trả', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, { ...base(), reminders: { ...DEFAULT_REMINDERS, events: { ...DEFAULT_REMINDERS.events, BEFORE_DUE: false } }, templates: { DUE: 'Đơn {ma_don} hết hạn, {ten_khach} ơi' } }));
    await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 5 * H) });
    await bk(s, { status: 'CONFIRMED', ends: new Date(NOW.getTime() - H) });
    await bk(s, { status: 'CLOSED', ends: new Date(NOW.getTime() - H) });
    await as(s.A, {}, (c) => scanReminders(c, NOW));
    expect(await log(s.A)).toHaveLength(0);
    await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() - 60_000) });
    await as(s.A, {}, (c) => scanReminders(c, NOW));
    expect((await log(s.A))[0].body).toMatch(/^Đơn .+ hết hạn, Nguyễn Văn An ơi$/);
  });

  it('cô lập tenant; tenant chỉ đọc không quét', async () => {
    const s = await shop();
    const B = await shop();
    await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 5 * H) });
    await as(B.A, {}, (c) => scanReminders(c, NOW));
    expect(await log(B.A)).toHaveLength(0);
    await expect(as(s.A, { status: 'READ_ONLY' }, (c) => scanReminders(c, NOW))).rejects.toThrow(ReadOnlyError);
    await expect(as(s.A, { role: 'STAFF' }, (c) => scanReminders(c, NOW))).rejects.toThrow(ForbiddenError);
  });
});

describe('gửi tin', () => {
  const queue = async (s: Shop, ends = new Date(NOW.getTime() + 5 * H)) => {
    await bk(s, { status: 'ACTIVE', ends });
    await as(s.A, {}, (c) => scanReminders(c, NOW));
  };

  it('gửi thành công: ghi nhà cung cấp, mã tin, thời điểm; chế độ giả lập không bị tính hạn mức', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    await queue(s);
    const f = fakes();
    expect(await as(s.A, {}, (c) => dispatchQueued(c, NOW, f.deps))).toMatchObject({ sent: 1, failed: 0 });
    const r = (await log(s.A))[0];
    expect(r).toMatchObject({ status: 'SENT', attempts: 1, scope: 'CONSOLE', error: null });
    expect(r.sent_at).not.toBeNull();
    expect(await as(s.A, {}, (c) => dispatchQueued(c, NOW, f.deps))).toMatchObject({ sent: 0 }); // không gửi lại
    expect(await as(s.A, { role: 'STAFF' }, (c) => listNotifications(c))).toHaveLength(1);
  });

  it('giờ nghỉ: hoãn tới 07:00 rồi gửi; tin gửi thử thì không bị hoãn', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    await queue(s);
    const night = new Date('2027-03-10T22:30:00+07:00');
    const f = fakes();
    expect(await as(s.A, {}, (c) => dispatchQueued(c, night, f.deps))).toMatchObject({ sent: 0, deferred: 1 });
    expect((await log(s.A))[0]).toMatchObject({ status: 'QUEUED' });
    expect((await log(s.A))[0].scheduled_for.toISOString()).toBe(new Date('2027-03-11T07:00:00+07:00').toISOString());
    expect(await as(s.A, {}, (c) => dispatchQueued(c, new Date('2027-03-11T06:00:00+07:00'), f.deps))).toMatchObject({ sent: 0, deferred: 0 });
    expect(await as(s.A, {}, (c) => dispatchQueued(c, new Date('2027-03-11T07:00:00+07:00'), f.deps))).toMatchObject({ sent: 1 });
    // tắt khung giờ nghỉ thì gửi ban đêm
    await as(s.A, {}, (c) => updateNotifySettings(c, { ...base(), quietHours: { enabled: false, start: '21:00', end: '07:00' } }));
    await queue(s);
    expect(await as(s.A, {}, (c) => dispatchQueued(c, night, f.deps))).toMatchObject({ sent: 1 });
  });

  it('lỗi tạm thời: thử lại giãn cách 5 → 20 phút rồi báo thất bại; lỗi vĩnh viễn thất bại ngay; gửi lại thủ công', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    await queue(s);
    const f = fakes();
    f.by.sms.results = [{ ok: false, error: 'Lỗi kết nối', retryable: true }, { ok: false, error: 'Lỗi kết nối', retryable: true }, { ok: false, error: 'Lỗi kết nối lần ba', retryable: true }];
    f.deps.build = () => f.by.sms;
    expect(await as(s.A, {}, (c) => dispatchQueued(c, NOW, f.deps))).toMatchObject({ retried: 1 });
    let r = (await log(s.A))[0];
    expect(r).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(r.scheduled_for.getTime()).toBe(NOW.getTime() + 5 * 60_000);
    expect(await as(s.A, {}, (c) => dispatchQueued(c, new Date(NOW.getTime() + 4 * 60_000), f.deps))).toMatchObject({ retried: 0, sent: 0 }); // chưa tới lúc
    const t2 = new Date(NOW.getTime() + 6 * 60_000);
    expect(await as(s.A, {}, (c) => dispatchQueued(c, t2, f.deps))).toMatchObject({ retried: 1 });
    r = (await log(s.A))[0];
    expect(r.scheduled_for.getTime()).toBe(t2.getTime() + 20 * 60_000);
    expect(await as(s.A, {}, (c) => dispatchQueued(c, new Date(t2.getTime() + 21 * 60_000), f.deps))).toMatchObject({ failed: 1 });
    r = (await log(s.A))[0];
    expect(r).toMatchObject({ status: 'FAILED', attempts: 3, error: 'Lỗi kết nối lần ba' });
    // gửi lại thủ công
    await expect(as(s.A, { role: 'STAFF' }, (c) => resendNotification(c, r.id))).rejects.toThrow(ForbiddenError);
    await as(s.A, {}, (c) => resendNotification(c, r.id));
    expect((await log(s.A))[0]).toMatchObject({ status: 'QUEUED', attempts: 0, error: null });
    expect(await as(s.A, {}, (c) => dispatchQueued(c, new Date(t2.getTime() + 22 * 60_000), f.deps))).toMatchObject({ sent: 1 });
    await expect(as(s.A, {}, (c) => resendNotification(c, r.id))).rejects.toThrow(/đã gửi thành công/);
    f.by.sms.results = [{ ok: false, error: 'Số không tồn tại', retryable: false }];
    await queue(s, new Date(NOW.getTime() + 3 * H)); // đơn mới (idempotency khác) để thử lỗi vĩnh viễn
    expect(await as(s.A, {}, (c) => dispatchQueued(c, new Date(t2.getTime() + 23 * 60_000), f.deps))).toMatchObject({ failed: 1 });
  });

  it('tài khoản chung: tính vào hạn mức tháng, cảnh báo ở 80% và chặn khi hết; tài khoản riêng/giả lập không tính', async () => {
    const s = await shop();
    await t.admin.query(`UPDATE tenant SET limit_overrides='{"messages_per_month": 5}' WHERE id=$1`, [s.A]);
    await as(s.A, {}, (c) => updateNotifySettings(c, { ...base(), channels: ['sms'], sms: { mode: 'shared' } }));
    const f = fakes();
    const ctxOpts: Opts = { limits: { messages_per_month: 5 } };
    for (let i = 0; i < 6; i++) await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + (3 + i) * H) });
    await as(s.A, ctxOpts, (c) => scanReminders(c, NOW));
    expect(await log(s.A)).toHaveLength(6);
    const res = await as(s.A, ctxOpts, (c) => dispatchQueued(c, NOW, f.deps));
    expect(res).toMatchObject({ sent: 5, skipped: 1 });
    const rows = await log(s.A);
    expect(rows.filter((r) => r.status === 'SENT').every((r) => r.scope === 'SHARED')).toBe(true);
    expect(rows.find((r) => r.status === 'SKIPPED').error).toMatch(/hết hạn mức 5 tin\/tháng/);
    expect(f.configs.at(-1)).toMatchObject({ mode: 'speedsms', accessToken: 'shared-token' });
    const titles = (await as(s.A, {}, (c) => listInbox(c))).items.map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(['Hết hạn mức tin nhắn tháng này', expect.stringMatching(/Đã dùng \d\/5/)]));
    // sang tháng mới thì dùng lại được
    await as(s.A, ctxOpts, (c) => scanReminders(c, NOW));
    const next = new Date('2027-04-02T10:00:00+07:00');
    await t.admin.query("UPDATE notification_log SET status='QUEUED', attempts=0, scheduled_for=$2 WHERE id=(SELECT id FROM notification_log WHERE tenant_id=$1 AND status='SKIPPED' LIMIT 1)", [s.A, next]);
    expect(await as(s.A, ctxOpts, (c) => dispatchQueued(c, next, f.deps))).toMatchObject({ sent: 1 });
  });

  it('chế độ chung nhưng nền tảng chưa có tài khoản: thất bại với thông báo rõ; kênh bị tắt theo gói: bỏ qua', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, { ...base(), channels: ['sms'], sms: { mode: 'shared' } }));
    await queue(s);
    expect(await as(s.A, {}, (c) => dispatchQueued(c, NOW, {}))).toMatchObject({ failed: 1 });
    expect((await log(s.A))[0].error).toMatch(/Nền tảng chưa cấu hình tài khoản gửi chung/);
    const s2 = await shop();
    await as(s2.A, {}, (c) => updateNotifySettings(c, base()));
    await queue(s2);
    expect(await as(s2.A, { off: ['notify.sms'] }, (c) => dispatchQueued(c, NOW, fakes().deps))).toMatchObject({ skipped: 1 });
    expect((await log(s2.A))[0].error).toMatch(/không có kênh này/);
  });

  it('gửi thử: kiểm tra đầu vào, ghi nhật ký, báo lỗi của nhà cung cấp', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    const f = fakes();
    await expect(as(s.A, {}, (c) => sendTestNotification(c, 'sms', '123', f.deps))).rejects.toThrow(/Số điện thoại không hợp lệ/);
    await expect(as(s.A, {}, (c) => sendTestNotification(c, 'email', 'abc', f.deps))).rejects.toThrow(/email không hợp lệ/);
    expect(await as(s.A, {}, (c) => sendTestNotification(c, 'sms', '0912345678', f.deps))).toMatchObject({ ok: true, message: expect.stringContaining('giả lập') });
    await expect(as(s.A, { off: ['notify.zalo'] }, (c) => sendTestNotification(c, 'zalo', '0912345678', f.deps))).rejects.toThrow(FeatureDisabledError);
    await expect(as(s.A, { role: 'STAFF' }, (c) => sendTestNotification(c, 'sms', '0912345678', f.deps))).rejects.toThrow(ForbiddenError);
    const rows = await log(s.A, `event='TEST'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'SENT', scope: 'CONSOLE' });
    f.deps.build = () => { const p = new Fake('sms'); p.results = [{ ok: false, error: 'Sai khóa', retryable: false }]; return p; };
    await as(s.A, {}, (c) => updateNotifySettings(c, { ...base(), sms: { mode: 'speedsms', apiKey: 'k' } }));
    expect(await as(s.A, {}, (c) => sendTestNotification(c, 'sms', '0912345678', f.deps))).toEqual({ ok: false, message: 'Sai khóa' });
    expect((await log(s.A, `event='TEST' AND status='FAILED'`))).toHaveLength(1);
  });
});

describe('hộp thư trong app', () => {
  it('lọc theo quyền, đánh dấu đã đọc theo từng người dùng, cô lập tenant', async () => {
    const s = await shop();
    const B = await shop();
    const u1 = randomUUID(), u2 = randomUUID();
    await t.admin.query("INSERT INTO app_notification(tenant_id,kind,title,permission,dedupe_key) VALUES ($1,'X','Cho mọi người',NULL,'a'), ($1,'X','Chỉ quản lý','users.manage','b')", [s.A]);
    const mgr = await as(s.A, { role: 'MANAGER', userId: u1 }, (c) => listInbox(c));
    expect(mgr.items.map((i) => i.title).sort()).toEqual(['Chỉ quản lý', 'Cho mọi người'].sort());
    expect(mgr.unread).toBe(2);
    const staff = await as(s.A, { role: 'STAFF', userId: u2 }, (c) => listInbox(c));
    expect(staff.items.map((i) => i.title)).toEqual(['Cho mọi người']);
    await as(s.A, { role: 'MANAGER', userId: u1 }, (c) => markInboxRead(c, mgr.items.find((i) => i.title === 'Chỉ quản lý')!.id));
    expect((await as(s.A, { role: 'MANAGER', userId: u1 }, (c) => listInbox(c))).unread).toBe(1);
    expect((await as(s.A, { role: 'STAFF', userId: u2 }, (c) => listInbox(c))).unread).toBe(1); // người khác chưa đọc
    await as(s.A, { role: 'MANAGER', userId: u1 }, (c) => markInboxRead(c));
    expect((await as(s.A, { role: 'MANAGER', userId: u1 }, (c) => listInbox(c))).unread).toBe(0);
    await as(s.A, { role: 'STAFF', userId: u2 }, (c) => markInboxRead(c)); // không đánh dấu được mục ngoài quyền
    expect((await t.admin.query("SELECT read_by FROM app_notification WHERE dedupe_key='b'")).rows[0].read_by).not.toContain(u2);
    expect((await as(B.A, { userId: u1 }, (c) => listInbox(c))).items).toEqual([]);
  });
});

describe('tác vụ nền', () => {
  const deps = (extra: Partial<Parameters<typeof runAllJobs>[0]> = {}) => ({ appPool: t.app, adminPool: t.platform, keyRing: ring, ...extra });

  it('chỉ chạy tenant đang hoạt động; hết hạn giữ chỗ, quét và gửi trong một vòng; ghi nhật ký từng bước', async () => {
    const s = await shop();
    const off = await shop();
    await t.admin.query("UPDATE tenant SET status='READ_ONLY' WHERE id=$1", [off.A]);
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 4 * H) });
    await bk(off, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 4 * H) });
    // tạo đơn giữ chỗ SAU CÙNG: mỗi lần đặt lịch mới đều tự hủy các phiếu giữ chỗ đã hết hạn
    const exp = await bk(s, { status: 'HOLD', hold: new Date(Date.now() - H) }); // hạn giữ chỗ tính theo đồng hồ DB thật
    expect((await listRunnableTenants(t.platform)).map((x) => x.id)).toContain(s.A);
    expect((await listRunnableTenants(t.platform)).map((x) => x.id)).not.toContain(off.A);
    const pc = new Map<string, ConsoleProvider>();
    const mine = (await runAllJobs(deps({ notify: { build: (c) => { const p = new ConsoleProvider(c.channel); pc.set(c.channel, p); return p; } }, publicUrl: (slug) => `http://${slug}.localhost:3000`, paySecret: SECRET }), NOW)).find((r) => r.tenantId === s.A)!;
    expect(mine.errors, mine.errors.join('|')).toEqual([]);
    expect(mine.holdsReleased).toBe(1);
    expect(mine.scan).toMatchObject({ queued: 1 });
    expect(mine.dispatch).toMatchObject({ sent: 1 });
    expect((await t.admin.query('SELECT status FROM booking WHERE id=$1', [exp])).rows[0].status).toBe('CANCELLED');
    expect(pc.get('sms')!.sent).toHaveLength(1);
    expect((await t.admin.query("SELECT name, ok FROM job_run WHERE tenant_id=$1 ORDER BY name", [s.A])).rows).toEqual([
      { name: 'extensions.jobs', ok: true }, { name: 'holds.release', ok: true }, { name: 'maintenance.scan', ok: true }, { name: 'notifications.dispatch', ok: true }, { name: 'reminders.scan', ok: true }, { name: 'webhooks.dispatch', ok: true },
    ]);
    expect(await log(off.A)).toHaveLength(0);
    // vòng sau không gửi lại
    const again = (await runAllJobs(deps({ notify: { build: (c) => new ConsoleProvider(c.channel) } }), NOW)).find((r) => r.tenantId === s.A)!;
    expect(again.scan).toMatchObject({ queued: 0 });
    expect(again.dispatch).toMatchObject({ sent: 0 });
  });

  it('liên kết thanh toán trong tin công nợ có chữ ký đúng tenant và đơn', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    const debt = await bk(s, { status: 'RETURNED', returned: new Date(NOW.getTime() - 2 * D) });
    await t.admin.query('UPDATE booking SET total=300000 WHERE id=$1', [debt]);
    const tn = (await listRunnableTenants(t.platform)).find((x) => x.id === s.A)!;
    await runTenantJobs(deps({ publicUrl: (slug) => `http://${slug}.localhost:3000`, paySecret: SECRET, notify: { build: (c) => new ConsoleProvider(c.channel) } }), tn, NOW);
    const body = (await log(s.A, `event='DEBT'`))[0].body as string;
    const m = new RegExp(`http://${tn.slug}\\.localhost:3000/pay/(\\S+?)\\.? `).exec(body + ' ');
    expect(m).not.toBeNull();
    expect(verifyToken<{ t: string; b: string }>(m![1]!.replace(/\.$/, ''), SECRET)).toMatchObject({ t: s.A, b: debt });
    expect(verifyToken(m![1]!.replace(/\.$/, ''), 'sai-bi-mat', NOW.getTime())).toBeNull();
  });

  it('một bước lỗi (gói không có tính năng thông báo) được ghi nhận, bước độc lập vẫn chạy, tenant khác không bị ảnh hưởng', async () => {
    const s = await shop('p');
    const ok = await shop();
    await as(ok.A, {}, (c) => updateNotifySettings(c, base()));
    await t.admin.query("UPDATE plan SET features = $1 WHERE code='p'", [JSON.stringify({ inventory: true, booking: true, customers: true, pricing: true })]);
    await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 4 * H) });
    await bk(ok, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 4 * H) });
    await bk(s, { status: 'HOLD', hold: new Date(Date.now() - H) });
    const res = await runAllJobs({ appPool: t.app, adminPool: t.platform, keyRing: ring, notify: { build: (c) => new ConsoleProvider(c.channel) } }, NOW);
    const r = res.find((x) => x.tenantId === s.A)!;
    expect(r.holdsReleased).toBe(1); // bước độc lập vẫn chạy
    expect(r.errors).toHaveLength(2);
    expect(r.errors.join(' ')).toMatch(/reminders\.scan.*notifications\.dispatch/);
    expect((await t.admin.query("SELECT name, ok FROM job_run WHERE tenant_id=$1 ORDER BY name", [s.A])).rows).toEqual([
      { name: 'holds.release', ok: true }, { name: 'notifications.dispatch', ok: false }, { name: 'reminders.scan', ok: false },
    ]);
    const good = res.find((x) => x.tenantId === ok.A)!;
    expect(good.errors).toEqual([]);
    expect(good.dispatch).toMatchObject({ sent: 1 });
    await t.admin.query("UPDATE plan SET features='{}' WHERE code='p'");
  });

  it('hai worker chạy cùng lúc không gửi trùng', async () => {
    const s = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 4 * H) });
    const tn = (await listRunnableTenants(t.platform)).find((x) => x.id === s.A)!;
    const sentTo: OutgoingMessage[] = [];
    const d = deps({ notify: { build: (c) => { const p = new ConsoleProvider(c.channel); const orig = p.send.bind(p); p.send = async (m) => { sentTo.push(m); return orig(m); }; return p; } } });
    await Promise.all([1, 2, 3].map(() => runTenantJobs(d, tn, NOW)));
    expect(sentTo).toHaveLength(1);
    expect(await log(s.A)).toHaveLength(1);
  });

  it('dọn nhật ký tác vụ cũ', async () => {
    const s = await shop();
    await withTenantId(t.app, s.A, (db) => db.query("INSERT INTO job_run(tenant_id,name,started_at,finished_at,ok) VALUES ($1,'x', now() - interval '40 days', now() - interval '40 days', true)", [s.A]));
    expect(await pruneJobRuns(t.platform, 30)).toBeGreaterThanOrEqual(1);
  });

  it('bảng thông báo bị RLS cô lập và nhật ký gửi không xóa được', async () => {
    const s = await shop();
    const B = await shop();
    await as(s.A, {}, (c) => updateNotifySettings(c, base()));
    await bk(s, { status: 'ACTIVE', ends: new Date(NOW.getTime() + 4 * H) });
    await as(s.A, {}, (c) => scanReminders(c, NOW));
    expect((await withTenantId(t.app, B.A, (db) => db.query('SELECT 1 FROM notification_log'))).rowCount).toBe(0);
    await expect(withTenantId(t.app, s.A, (db) => db.query('DELETE FROM notification_log'))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, s.A, (db) => db.query("UPDATE notification_log SET event='X'"))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, B.A, (db) => db.query("INSERT INTO notification_log(tenant_id,event,channel,recipient,body,idempotency_key) VALUES ($1,'X','sms','1','b','k')", [s.A]))).rejects.toThrow();
  });
});
