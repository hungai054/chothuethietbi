import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import {
  PlatformError, SYSTEM_ACTOR, businessMetrics, changePlanMidTerm, createCoupon, createSubscriptionInvoice, createTenant, dispatchPlatformEmails,
  extendSubscriptionManual, getBillingConfig, getSubscription, listInvoices, markInvoicePaid, nextOrderCode, quotePlanChange, setBillingConfig,
  setCouponActive, sweepSubscriptions, voidInvoice, withTenantId, type Actor,
} from '../src';

let t: TestDb;
let actor: Actor;
const DAY = 86_400_000;
const T0 = new Date('2027-03-01T00:00:00Z');

beforeAll(async () => {
  t = await startTestDb(54331);
  await t.admin.query(`INSERT INTO plan(code,name,price_month,price_year) VALUES ('basic','Cơ bản',300000,3000000),('pro','Chuyên nghiệp',800000,8000000)`);
  await t.admin.query(`INSERT INTO plan(code,name,price_month,price_year,is_custom) VALUES ('ent','Doanh nghiệp',0,0,true)`);
  const u = await t.admin.query("INSERT INTO platform_user(email,password_hash,role) VALUES ('sa@x.vn','x','SUPER_ADMIN') RETURNING id");
  actor = { id: u.rows[0].id, email: 'sa@x.vn' };
}, 120_000);
afterAll(async () => { await t?.stop(); });

let n = 0;
const mk = async (plan = 'basic') => (await createTenant(t.platform, actor, { slug: `bill-${Date.now().toString(36)}-${++n}`, name: `Shop ${n}`, planCode: plan, ownerEmail: `o${n}@x.vn`, ownerName: 'Chủ' })).tenantId;
const status = async (id: string) => (await t.platform.query('SELECT status, locked_by_billing AS l FROM tenant WHERE id=$1', [id])).rows[0] as { status: string; l: boolean };
const pay = (invoiceId: string, extra: object = {}, now = T0) => markInvoicePaid(t.platform, actor, { invoiceId, by: 'test', provider: 'MANUAL', ...extra }, now);

describe('hóa đơn thuê bao', () => {
  it('tạo hóa đơn tháng/năm đúng giá và số hóa đơn tăng dần', async () => {
    const id = await mk();
    const a = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'pro', cycle: 'MONTH' }, T0);
    expect(Number(a.amount)).toBe(800_000);
    expect(a.number).toMatch(/^HD-\d{4}-\d{5}$/);
    expect(a.status).toBe('OPEN');
    expect(a.period_end.toISOString()).toBe('2027-04-01T00:00:00.000Z');
    const b = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'pro', cycle: 'YEAR' }, T0);
    expect(Number(b.amount)).toBe(8_000_000);
    expect(b.number > a.number).toBe(true);
    expect((await t.platform.query('SELECT status FROM invoice WHERE id=$1', [a.id])).rows[0].status).toBe('VOID'); // chỉ còn một hóa đơn mở
  });

  it('tạo lại hóa đơn giống hệt trả về hóa đơn cũ (bấm đúp không sinh thêm)', async () => {
    const id = await mk();
    const a = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, T0);
    const b = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, T0);
    expect(b.id).toBe(a.id);
  });

  it('gói báo giá riêng, gói/chu kỳ sai bị từ chối bằng tiếng Việt', async () => {
    const id = await mk();
    await expect(createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'ent', cycle: 'MONTH' }, T0)).rejects.toThrow(/báo giá riêng/);
    await expect(createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'zzz', cycle: 'MONTH' }, T0)).rejects.toThrow(/Không có gói/);
    await expect(createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'WEEK' }, T0)).rejects.toThrow(/Chu kỳ/);
  });

  it('thanh toán kích hoạt: tenant ACTIVE, thuê bao đúng kỳ, MRR, sự kiện ACTIVATE; trả lại lần 2 không cộng kỳ', async () => {
    const id = await mk();
    expect((await status(id)).status).toBe('TRIAL');
    const inv = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'pro', cycle: 'YEAR' }, T0);
    const r = await pay(inv.id);
    expect(r.already).toBe(false);
    expect((await status(id)).status).toBe('ACTIVE');
    const sub = (await getSubscription(t.platform, id))!;
    expect(sub.plan_code).toBe('pro');
    expect(sub.period_end!.toISOString()).toBe('2028-03-01T00:00:00.000Z');
    expect(Number(sub.mrr)).toBe(666_667);
    const again = await pay(inv.id);
    expect(again.already).toBe(true);
    expect((await getSubscription(t.platform, id))!.period_end!.toISOString()).toBe('2028-03-01T00:00:00.000Z');
    const ev = (await t.platform.query("SELECT kind FROM subscription_event WHERE tenant_id=$1 ORDER BY id", [id])).rows.map((x) => x.kind);
    expect(ev).toEqual(['TRIAL_START', 'ACTIVATE']);
    expect((await t.platform.query("SELECT 1 FROM platform_email WHERE tenant_id=$1 AND kind='invoice.paid'", [id])).rowCount).toBe(1);
  });

  it('webhook trùng (cùng eventId) chỉ xử lý một lần; sai số tiền không kích hoạt', async () => {
    const id = await mk();
    const inv = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, T0);
    const code = await nextOrderCode(t.platform, inv.id);
    await expect(markInvoicePaid(t.platform, SYSTEM_ACTOR, { orderCode: code, by: 'payos', provider: 'PAYOS', eventId: 'EV1', amount: 1 }, T0)).rejects.toThrow(/khác hóa đơn/);
    expect((await status(id)).status).toBe('TRIAL');
    const ok = await markInvoicePaid(t.platform, SYSTEM_ACTOR, { orderCode: code, by: 'payos', provider: 'PAYOS', eventId: 'EV2', amount: 300_000 }, T0);
    expect(ok.already).toBe(false);
    const dup = await markInvoicePaid(t.platform, SYSTEM_ACTOR, { orderCode: code, by: 'payos', provider: 'PAYOS', eventId: 'EV2', amount: 300_000 }, T0);
    expect(dup.already).toBe(true);
    expect((await t.platform.query("SELECT count(*)::int AS n FROM subscription_event WHERE tenant_id=$1 AND kind='ACTIVATE'", [id])).rows[0].n).toBe(1);
  });

  it('hai thanh toán đồng thời cùng một hóa đơn chỉ ghi nhận một lần', async () => {
    const id = await mk();
    const inv = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, T0);
    const rs = await Promise.all([pay(inv.id), pay(inv.id), pay(inv.id)]);
    expect(rs.filter((r) => !r.already).length).toBe(1);
    expect((await t.platform.query('SELECT count(*)::int AS n FROM subscription_event WHERE tenant_id=$1 AND kind=\'ACTIVATE\'', [id])).rows[0].n).toBe(1);
  });

  it('hóa đơn đã hủy không kích hoạt và để lại dấu vết', async () => {
    const id = await mk();
    const inv = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, T0);
    await expect(voidInvoice(t.platform, actor, inv.id, 'x')).rejects.toThrow(/lý do/);
    await voidInvoice(t.platform, actor, inv.id, 'Khách yêu cầu hủy');
    await expect(pay(inv.id)).rejects.toThrow(/đã bị hủy/);
    expect((await status(id)).status).toBe('TRIAL');
    expect((await t.platform.query("SELECT 1 FROM platform_audit WHERE tenant_id=$1 AND action='billing.paid_void_invoice'", [id])).rowCount).toBe(1);
  });

  it('gia hạn khi còn hạn nối tiếp kỳ cũ, không mất ngày đã trả', async () => {
    const id = await mk();
    await pay((await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, T0)).id);
    const inv2 = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, new Date(T0.getTime() + 10 * DAY));
    expect(inv2.period_start.toISOString()).toBe('2027-04-01T00:00:00.000Z');
    await pay(inv2.id, {}, new Date(T0.getTime() + 10 * DAY));
    expect((await getSubscription(t.platform, id))!.period_end!.toISOString()).toBe('2027-05-01T00:00:00.000Z');
    const kinds = (await t.platform.query("SELECT kind FROM subscription_event WHERE tenant_id=$1 ORDER BY id", [id])).rows.map((x) => x.kind);
    expect(kinds).toEqual(['TRIAL_START', 'ACTIVATE', 'RENEW']);
  });
});

describe('mã giảm giá', () => {
  it('giảm theo % áp vào hóa đơn, tăng lượt dùng khi trả tiền, hết lượt thì từ chối', async () => {
    await createCoupon(t.platform, actor, { code: 'SALE20', percentOff: 20, maxRedemptions: 1 });
    const id = await mk();
    const inv = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'pro', cycle: 'MONTH', couponCode: 'sale20' }, T0);
    expect(Number(inv.discount)).toBe(160_000);
    expect(Number(inv.amount)).toBe(640_000);
    await pay(inv.id);
    expect((await t.platform.query("SELECT redeemed FROM coupon WHERE code='SALE20'")).rows[0].redeemed).toBe(1);
    const other = await mk();
    await expect(createSubscriptionInvoice(t.platform, actor, { tenantId: other, planCode: 'pro', cycle: 'MONTH', couponCode: 'SALE20' }, T0)).rejects.toThrow(/hết lượt/);
  });

  it('mã sai gói, đã tắt, không tồn tại, cấu hình sai bị từ chối', async () => {
    await createCoupon(t.platform, actor, { code: 'ONLYBASIC', amountOff: 50_000, planCodes: ['basic'] });
    const id = await mk();
    await expect(createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'pro', cycle: 'MONTH', couponCode: 'ONLYBASIC' }, T0)).rejects.toThrow(/không áp dụng/);
    const cid = (await t.platform.query("SELECT id FROM coupon WHERE code='ONLYBASIC'")).rows[0].id;
    await setCouponActive(t.platform, actor, cid, false);
    await expect(createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH', couponCode: 'ONLYBASIC' }, T0)).rejects.toThrow(/đã bị tắt/);
    await expect(createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH', couponCode: 'KHONGCO' }, T0)).rejects.toThrow(/Không có mã/);
    await expect(createCoupon(t.platform, actor, { code: 'AB', percentOff: 10 })).rejects.toThrow(/3–30/);
    await expect(createCoupon(t.platform, actor, { code: 'BOTH', percentOff: 10, amountOff: 1000 })).rejects.toThrow(/HOẶC/);
    await expect(createCoupon(t.platform, actor, { code: 'SALE20', percentOff: 10 })).rejects.toThrow(/đã tồn tại/);
  });
});

describe('đổi gói giữa kỳ', () => {
  const setup = async () => {
    const id = await mk();
    await pay((await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, T0)).id);
    return id; // kỳ 1/3 → 1/4 (31 ngày)
  };

  it('nâng gói: hóa đơn chênh lệch theo ngày còn lại, gói chỉ đổi khi đã trả', async () => {
    const id = await setup();
    const mid = new Date('2027-03-16T00:00:00Z');
    const q = await quotePlanChange(t.platform, id, 'pro', mid);
    expect(q.direction).toBe('UP');
    const r = await changePlanMidTerm(t.platform, actor, id, 'pro', mid);
    expect(r.applied).toBe(false);
    const inv = r.invoice!;
    expect(inv.kind).toBe('UPGRADE');
    expect(Number(inv.amount)).toBe(Math.round(800_000 * 16 / 31) - Math.round(300_000 * 16 / 31));
    expect((await getSubscription(t.platform, id))!.plan_code).toBe('basic');
    await pay(inv.id, {}, mid);
    const sub = (await getSubscription(t.platform, id))!;
    expect(sub.plan_code).toBe('pro');
    expect(sub.period_end!.toISOString()).toBe('2027-04-01T00:00:00.000Z'); // kỳ không đổi
    expect((await t.platform.query('SELECT plan_id FROM tenant WHERE id=$1', [id])).rows[0].plan_id).toBe((await t.platform.query("SELECT id FROM plan WHERE code='pro'")).rows[0].id);
  });

  it('hạ gói: áp dụng ngay, phần dư thành số dư và được trừ vào hóa đơn kế tiếp', async () => {
    const id = await mk('pro');
    await pay((await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'pro', cycle: 'MONTH' }, T0)).id);
    const mid = new Date('2027-03-16T00:00:00Z');
    const r = await changePlanMidTerm(t.platform, actor, id, 'basic', mid);
    expect(r.applied).toBe(true);
    expect(r.creditLeft).toBeGreaterThan(0);
    const sub = (await getSubscription(t.platform, id))!;
    expect(sub.plan_code).toBe('basic');
    expect(Number(sub.credit)).toBe(r.creditLeft);
    const next = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, mid);
    expect(Number(next.credit_used)).toBe(Math.min(r.creditLeft, 300_000));
    expect(Number(next.amount)).toBe(300_000 - Number(next.credit_used));
    await pay(next.id, {}, mid);
    expect(Number((await getSubscription(t.platform, id))!.credit)).toBe(r.creditLeft - Number(next.credit_used));
  });

  it('không đổi giữa kỳ khi chưa có thuê bao, cùng gói, hoặc gói báo giá riêng', async () => {
    const none = await mk();
    await expect(changePlanMidTerm(t.platform, actor, none, 'pro', T0)).rejects.toThrow(/giữa kỳ/);
    const id = await setup();
    await expect(changePlanMidTerm(t.platform, actor, id, 'basic', new Date('2027-03-10T00:00:00Z'))).rejects.toThrow(/gói này rồi/);
    await expect(changePlanMidTerm(t.platform, actor, id, 'ent', new Date('2027-03-10T00:00:00Z'))).rejects.toThrow(/báo giá riêng/);
  });
});

describe('vòng đời hết hạn (quét)', () => {
  const paid = async (when = T0) => {
    const id = await mk();
    await pay((await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, when)).id, {}, when);
    return id; // hết hạn 1/4/2027
  };
  const sweep = (now: Date) => sweepSubscriptions(t.platform, now);

  it('còn hạn và ân hạn: giữ nguyên; qua ân hạn: chỉ đọc; qua thời gian chờ: khóa; không xóa dữ liệu', async () => {
    const id = await paid();
    await t.admin.query("INSERT INTO customer(tenant_id,name,phone) VALUES ($1,'Khách còn mãi','0900000000')", [id]);
    await sweep(new Date('2027-03-31T00:00:00Z'));
    expect((await status(id)).status).toBe('ACTIVE');
    await sweep(new Date('2027-04-03T00:00:00Z')); // trong 3 ngày ân hạn
    expect((await status(id)).status).toBe('ACTIVE');
    const r1 = await sweep(new Date('2027-04-10T00:00:00Z'));
    expect(r1.readOnly).toContain(id);
    expect(await status(id)).toEqual({ status: 'READ_ONLY', l: true });
    const r2 = await sweep(new Date('2027-04-20T00:00:00Z'));
    expect(r2.readOnly).not.toContain(id);
    const r3 = await sweep(new Date('2027-06-15T00:00:00Z'));
    expect(r3.suspended).toContain(id);
    expect((await status(id)).status).toBe('SUSPENDED');
    expect((await withTenantId(t.app, id, (db) => db.query('SELECT 1 FROM customer'))).rowCount).toBe(1);
    expect((await t.platform.query("SELECT 1 FROM platform_email WHERE tenant_id=$1 AND kind='billing.read_only'", [id])).rowCount).toBe(1);
  });

  it('thanh toán mở lại tenant bị khóa do hết hạn', async () => {
    const id = await paid();
    await sweep(new Date('2027-04-10T00:00:00Z'));
    expect((await status(id)).status).toBe('READ_ONLY');
    const now = new Date('2027-04-12T00:00:00Z');
    const inv = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, now);
    expect(inv.period_start.toISOString()).toBe(now.toISOString()); // đã hết hạn nên kỳ mới tính từ bây giờ
    await pay(inv.id, {}, now);
    expect(await status(id)).toEqual({ status: 'ACTIVE', l: false });
    const kinds = (await t.platform.query("SELECT kind FROM subscription_event WHERE tenant_id=$1 ORDER BY id", [id])).rows.map((x) => x.kind);
    expect(kinds.slice(-2)).toEqual(['READ_ONLY', 'REACTIVATE']);
  });

  it('khóa tay của quản trị viên không bị quét hay thanh toán tự mở', async () => {
    const id = await paid();
    await t.platform.query("UPDATE tenant SET status='SUSPENDED', locked_by_billing=false WHERE id=$1", [id]);
    await sweep(new Date('2027-03-10T00:00:00Z'));
    expect((await status(id)).status).toBe('SUSPENDED');
    const inv = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'basic', cycle: 'MONTH' }, T0);
    await pay(inv.id);
    expect((await status(id)).status).toBe('SUSPENDED');
  });

  it('dùng thử hết hạn cũng chuyển chỉ đọc; tenant ACTIVE chưa có thuê bao (hợp đồng ngoài) không bị đụng', async () => {
    const trial = await mk();
    await t.platform.query("UPDATE tenant SET trial_ends_at=$2 WHERE id=$1", [trial, new Date('2027-03-01T00:00:00Z')]);
    const contract = await mk();
    await t.platform.query("UPDATE tenant SET status='ACTIVE', trial_ends_at=$2 WHERE id=$1", [contract, new Date('2020-01-01T00:00:00Z')]);
    await sweep(new Date('2027-03-10T00:00:00Z'));
    expect((await status(trial)).status).toBe('READ_ONLY');
    expect((await status(contract)).status).toBe('ACTIVE');
  });

  it('gia hạn thủ công không thời hạn (hợp đồng ký ngoài) không bao giờ hết hạn', async () => {
    const id = await mk();
    await extendSubscriptionManual(t.platform, actor, { tenantId: id, planCode: 'ent', cycle: 'YEAR', endsAt: null, amount: 0, note: 'HĐ 2027/01' }, T0);
    await sweep(new Date('2040-01-01T00:00:00Z'));
    expect((await status(id)).status).toBe('ACTIVE');
    await expect(extendSubscriptionManual(t.platform, actor, { tenantId: id, planCode: 'ent', cycle: 'YEAR', endsAt: new Date('2020-01-01') }, T0)).rejects.toThrow(/tương lai/);
  });

  it('nhắc gia hạn: mỗi mốc gửi đúng một lần, mốc mới nhất', async () => {
    const id = await paid();
    await sweep(new Date('2027-03-15T00:00:00Z')); // còn 17 ngày: chưa nhắc
    expect((await t.platform.query("SELECT 1 FROM platform_email WHERE tenant_id=$1 AND kind='billing.reminder'", [id])).rowCount).toBe(0);
    await sweep(new Date('2027-03-26T00:00:00Z')); // còn 6 ngày: mốc 7
    await sweep(new Date('2027-03-26T06:00:00Z')); // quét lại: không gửi trùng
    expect((await t.platform.query("SELECT 1 FROM platform_email WHERE tenant_id=$1 AND kind='billing.reminder'", [id])).rowCount).toBe(1);
    await sweep(new Date('2027-03-31T12:00:00Z')); // mốc 1 ngày
    expect((await t.platform.query("SELECT 1 FROM platform_email WHERE tenant_id=$1 AND kind='billing.reminder'", [id])).rowCount).toBe(2);
  });

  it('cấu hình ân hạn/khóa đổi được và kiểm tra đầu vào', async () => {
    await setBillingConfig(t.platform, actor, { trialDays: 7, graceDays: 0, lockDays: 10 });
    expect(await getBillingConfig(t.platform)).toEqual({ trialDays: 7, graceDays: 0, lockDays: 10 });
    const id = await paid();
    const r = await sweep(new Date('2027-04-02T00:00:00Z'));
    expect(r.readOnly).toContain(id); // ân hạn 0 ngày
    await expect(setBillingConfig(t.platform, actor, { trialDays: -1, graceDays: 3, lockDays: 30 })).rejects.toThrow(PlatformError);
    await setBillingConfig(t.platform, actor, { trialDays: 14, graceDays: 3, lockDays: 30 });
  });
});

describe('quyền truy cập dữ liệu thuê bao', () => {
  it('cửa hàng chỉ đọc được hóa đơn/thuê bao của chính mình và không ghi được', async () => {
    const a = await mk();
    const b = await mk();
    const ia = await createSubscriptionInvoice(t.platform, actor, { tenantId: a, planCode: 'basic', cycle: 'MONTH' }, T0);
    await createSubscriptionInvoice(t.platform, actor, { tenantId: b, planCode: 'pro', cycle: 'MONTH' }, T0);
    const seen = (await withTenantId(t.app, a, (db) => db.query('SELECT id FROM invoice'))).rows.map((r) => r.id);
    expect(seen).toEqual([ia.id]);
    await expect(withTenantId(t.app, a, (db) => db.query("UPDATE invoice SET status='PAID', paid_at=now() WHERE id=$1", [ia.id]))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, a, (db) => db.query('DELETE FROM subscription'))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, a, (db) => db.query('SELECT * FROM coupon'))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, a, (db) => db.query('SELECT * FROM platform_email'))).rejects.toThrow(/permission denied/);
  });

  it('ràng buộc DB: số tiền hóa đơn phải khớp, trả rồi phải có ngày trả', async () => {
    const a = await mk();
    const inv = await createSubscriptionInvoice(t.platform, actor, { tenantId: a, planCode: 'basic', cycle: 'MONTH' }, T0);
    await expect(t.platform.query('UPDATE invoice SET amount = amount + 1 WHERE id=$1', [inv.id])).rejects.toThrow(/check/);
    await expect(t.platform.query("UPDATE invoice SET status='PAID' WHERE id=$1", [inv.id])).rejects.toThrow(/check/);
  });
});

describe('thư đi của nền tảng', () => {
  it('không có nhà gửi thì ghi CONSOLE; có nhà gửi thì SENT; lỗi thì thử lại rồi FAILED', async () => {
    await t.platform.query("UPDATE platform_email SET status='SENT' WHERE status='QUEUED'");
    await t.platform.query("INSERT INTO platform_email(kind,to_email,subject,body) VALUES ('t','a@x.vn','s','b')");
    expect((await dispatchPlatformEmails(t.platform, null)).console).toBe(1);
    await t.platform.query("INSERT INTO platform_email(kind,to_email,subject,body) VALUES ('t','b@x.vn','s','b')");
    const got: string[] = [];
    expect((await dispatchPlatformEmails(t.platform, { send: async (m) => { got.push(m.to); } })).sent).toBe(1);
    expect(got).toEqual(['b@x.vn']);
    await t.platform.query("INSERT INTO platform_email(kind,to_email,subject,body) VALUES ('t','c@x.vn','s','b')");
    for (let i = 0; i < 5; i++) await dispatchPlatformEmails(t.platform, { send: async () => { throw new Error('SMTP chết'); } });
    const row = (await t.platform.query("SELECT status, attempts, error FROM platform_email WHERE to_email='c@x.vn'")).rows[0];
    expect(row).toMatchObject({ status: 'FAILED', attempts: 5, error: 'SMTP chết' });
  });
});

describe('số liệu kinh doanh', () => {
  it('MRR, theo gói, khách mới, rời bỏ, chuyển đổi dùng thử, doanh thu, sắp hết hạn', async () => {
    const now = new Date();
    const range = { from: new Date(now.getTime() - 3600_000), to: new Date(now.getTime() + 3600_000) };
    await sweepSubscriptions(t.platform, now); // đưa các tenant của test trước (đặt giờ năm 2027) về trạng thái theo giờ thật
    const before = await businessMetrics(t.platform, range, now);
    const id = await mk('pro');
    const inv = await createSubscriptionInvoice(t.platform, actor, { tenantId: id, planCode: 'pro', cycle: 'YEAR' }, now);
    await markInvoicePaid(t.platform, actor, { invoiceId: inv.id, by: 'test', provider: 'MANUAL' }, now);
    const lapsed = await mk();
    await t.platform.query("UPDATE tenant SET trial_ends_at=$2 WHERE id=$1", [lapsed, new Date(now.getTime() - 40 * DAY)]);
    await sweepSubscriptions(t.platform, now);
    const m = await businessMetrics(t.platform, range, now);
    expect(m.mrr - before.mrr).toBe(666_667);
    expect(m.arr).toBe(m.mrr * 12);
    expect(m.newCustomers - before.newCustomers).toBe(1);
    expect(m.churned).toBeGreaterThan(before.churned);
    expect(m.trialStarted).toBeGreaterThan(before.trialStarted);
    expect(m.trialConverted - before.trialConverted).toBe(1);
    expect(m.conversionRate).toBeGreaterThan(0);
    expect(m.byPlan.find((p) => p.plan === 'pro')!.mrr).toBeGreaterThanOrEqual(666_667);
    expect(m.revenueByMonth.reduce((a, r) => a + r.revenue, 0)).toBeGreaterThanOrEqual(8_000_000);
    const list = await listInvoices(t.platform, { tenantId: id });
    expect(list.length).toBe(1);
  });
});
