import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import {
  DEFAULT_LIFECYCLE, addCycle, applyCoupon, assertCouponUsable, dueRenewalReminder, isCycle, mrrOf, newPayCode, planPrice, prorateChange, statusForPhase, subscriptionPhase,
  type Cycle, type LifecycleConfig, type Proration,
} from '@rentpro/core';
import { PlatformError, platformAudit, platformTx, type Actor } from './platform';

/**
 * Thuê bao, hóa đơn, thanh toán, vòng đời hết hạn, mã giảm giá, số liệu kinh doanh.
 * Mọi hàm nhận pool của role quản trị (ghi bảng nền tảng); chỉ gọi sau khi đã kiểm quyền ở tầng trên
 * (cổng quản trị theo quyền nền tảng, hoặc trang cửa hàng theo `billing.manage` với tenantId lấy từ phiên).
 */
type Pool = pg.Pool;
type Db = pg.PoolClient | Pool;

export const SYSTEM_ACTOR: Actor = { id: '00000000-0000-0000-0000-000000000000', email: 'system' };

// ===== Cấu hình =====
export interface BillingConfig extends LifecycleConfig { trialDays: number }
export const DEFAULT_BILLING_CONFIG: BillingConfig = { ...DEFAULT_LIFECYCLE, trialDays: 14 };

export async function getBillingConfig(db: Db): Promise<BillingConfig> {
  const r = (await db.query("SELECT value FROM platform_setting WHERE key='billing'")).rows[0]?.value as Partial<BillingConfig> | undefined;
  return { ...DEFAULT_BILLING_CONFIG, ...(r ?? {}) };
}

export async function setBillingConfig(pool: Pool, actor: Actor, cfg: BillingConfig): Promise<void> {
  for (const [k, v, max] of [['trialDays', cfg.trialDays, 90], ['graceDays', cfg.graceDays, 30], ['lockDays', cfg.lockDays, 365]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > max) throw new PlatformError(`"${k}" phải là số nguyên từ 0 đến ${max}.`);
  }
  await pool.query(
    `INSERT INTO platform_setting(key,value) VALUES ('billing',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(cfg)],
  );
  await platformAudit(pool, actor, 'billing.config', null, { ...cfg });
}

// ===== Thư đi =====
export async function queueEmail(db: Db, m: { tenantId?: string | null; kind: string; to: string; subject: string; body: string }): Promise<void> {
  await db.query('INSERT INTO platform_email(tenant_id,kind,to_email,subject,body) VALUES ($1,$2,$3,$4,$5)', [m.tenantId ?? null, m.kind, m.to.toLowerCase(), m.subject, m.body]);
}

async function ownerEmails(db: Db, tenantId: string): Promise<string[]> {
  const r = await db.query("SELECT email FROM app_user WHERE tenant_id=$1 AND role='OWNER' AND active ORDER BY created_at", [tenantId]);
  return r.rows.map((x: { email: string }) => x.email);
}

export interface EmailSender { send(m: { to: string; subject: string; body: string }): Promise<void> }

/** Gửi thư đang chờ. Không có nhà gửi thì đánh dấu CONSOLE (môi trường dev/test, nội dung vẫn đọc được trong bảng). */
export async function dispatchPlatformEmails(pool: Pool, sender: EmailSender | null, limit = 50): Promise<{ sent: number; failed: number; console: number }> {
  const out = { sent: 0, failed: 0, console: 0 };
  // Một giao dịch giữ khóa dòng suốt lúc gửi để hai worker không gửi trùng một thư
  await platformTx(pool, async (db) => {
    const rows = (await db.query(
      `SELECT id, to_email, subject, body, attempts FROM platform_email WHERE status='QUEUED' ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    for (const m of rows) {
      if (!sender) {
        await db.query("UPDATE platform_email SET status='CONSOLE', sent_at=now() WHERE id=$1", [m.id]);
        out.console++;
        continue;
      }
      try {
        await sender.send({ to: m.to_email, subject: m.subject, body: m.body });
        await db.query("UPDATE platform_email SET status='SENT', sent_at=now(), attempts=attempts+1 WHERE id=$1", [m.id]);
        out.sent++;
      } catch (e) {
        const failed = m.attempts + 1 >= 5;
        await db.query('UPDATE platform_email SET status=$2, attempts=attempts+1, error=$3 WHERE id=$1', [m.id, failed ? 'FAILED' : 'QUEUED', e instanceof Error ? e.message : String(e)]);
        out.failed++;
      }
    }
  });
  return out;
}

// ===== Mã giảm giá =====
export interface CouponRow {
  id: string; code: string; description: string | null; percent_off: number | null; amount_off: string | null; plan_codes: string[] | null;
  valid_until: Date | null; max_redemptions: number | null; redeemed: number; active: boolean; created_at: Date;
}

export async function listCoupons(pool: Pool): Promise<CouponRow[]> {
  return (await pool.query('SELECT * FROM coupon ORDER BY created_at DESC')).rows;
}

export interface CouponInput {
  code: string; description?: string; percentOff?: number | null; amountOff?: number | null; planCodes?: string[] | null; validUntil?: Date | null; maxRedemptions?: number | null;
}

export async function createCoupon(pool: Pool, actor: Actor, i: CouponInput): Promise<string> {
  const code = i.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new PlatformError('Mã giảm giá gồm chữ hoa, số, gạch (3–30 ký tự).');
  const pct = i.percentOff ?? null;
  const amt = i.amountOff ?? null;
  if ((pct === null) === (amt === null)) throw new PlatformError('Chọn giảm theo % HOẶC theo số tiền (một trong hai).');
  if (pct !== null && (!Number.isInteger(pct) || pct < 1 || pct > 100)) throw new PlatformError('Phần trăm giảm từ 1 đến 100.');
  if (amt !== null && (!Number.isInteger(amt) || amt <= 0)) throw new PlatformError('Số tiền giảm phải là số nguyên dương.');
  if (i.maxRedemptions != null && (!Number.isInteger(i.maxRedemptions) || i.maxRedemptions < 1)) throw new PlatformError('Số lượt dùng tối đa phải ≥ 1.');
  try {
    const r = await pool.query(
      `INSERT INTO coupon(code,description,percent_off,amount_off,plan_codes,valid_until,max_redemptions) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [code, i.description?.trim() || null, pct, amt, i.planCodes?.length ? i.planCodes : null, i.validUntil ?? null, i.maxRedemptions ?? null],
    );
    await platformAudit(pool, actor, 'coupon.create', null, { code, pct, amt });
    return r.rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new PlatformError('Mã giảm giá đã tồn tại.');
    throw e;
  }
}

export async function setCouponActive(pool: Pool, actor: Actor, id: string, active: boolean): Promise<void> {
  await pool.query('UPDATE coupon SET active=$2 WHERE id=$1', [id, active]);
  await platformAudit(pool, actor, 'coupon.active', null, { id, active });
}

async function findCoupon(db: Db, code: string, planCode: string, now: Date, lock = false) {
  const c = (await db.query(`SELECT * FROM coupon WHERE code=$1 ${lock ? 'FOR UPDATE' : ''}`, [code.trim().toUpperCase()])).rows[0] as CouponRow | undefined;
  if (!c) throw new PlatformError('Không có mã giảm giá này.');
  try {
    assertCouponUsable({
      code: c.code, active: c.active, validUntil: c.valid_until, maxRedemptions: c.max_redemptions, redeemed: c.redeemed, planCodes: c.plan_codes,
      percentOff: c.percent_off, amountOff: c.amount_off === null ? null : Number(c.amount_off),
    }, planCode, now);
  } catch (e) {
    throw new PlatformError(e instanceof Error ? e.message : String(e));
  }
  return c;
}

// ===== Thuê bao hiện tại =====
export interface SubscriptionRow {
  tenant_id: string; plan_code: string; plan_name: string; cycle: Cycle; period_start: Date; period_end: Date | null; price_paid: string; mrr: string; credit: string;
}

export async function getSubscription(db: Db, tenantId: string): Promise<SubscriptionRow | null> {
  const r = await db.query(
    `SELECT s.tenant_id, p.code AS plan_code, p.name AS plan_name, s.cycle, s.period_start, s.period_end, s.price_paid, s.mrr, s.credit
     FROM subscription s JOIN plan p ON p.id = s.plan_id WHERE s.tenant_id=$1`, [tenantId]);
  return r.rows[0] ?? null;
}

export interface PlanRow { id: string; code: string; name: string; price_month: number; price_year: number; is_custom: boolean }

async function getPlan(db: Db, code: string): Promise<PlanRow> {
  const p = (await db.query('SELECT id, code, name, price_month::int, price_year::int, is_custom FROM plan WHERE code=$1', [code])).rows[0] as PlanRow | undefined;
  if (!p) throw new PlatformError(`Không có gói "${code}".`);
  return p;
}

/** Gói mua được trực tuyến: có giá. Gói Doanh nghiệp (giá 0, báo giá riêng) phải qua bán hàng/gia hạn thủ công. */
export const isSelfServePlan = (p: Pick<PlanRow, 'price_month' | 'price_year' | 'is_custom'>) => !p.is_custom && p.price_month > 0;

export interface Quote {
  plan: PlanRow; cycle: Cycle; subtotal: number; discount: number; creditUsed: number; amount: number; periodStart: Date; periodEnd: Date; couponCode: string | null;
}

/** Báo giá mua/gia hạn: kỳ mới nối tiếp kỳ hiện tại nếu còn hạn, ngược lại tính từ bây giờ. */
export async function quoteSubscription(db: Db, i: { tenantId: string; planCode: string; cycle: string; couponCode?: string | null }, now = new Date()): Promise<Quote> {
  if (!isCycle(i.cycle)) throw new PlatformError('Chu kỳ phải là tháng hoặc năm.');
  const plan = await getPlan(db, i.planCode);
  if (!isSelfServePlan(plan)) throw new PlatformError('Gói này báo giá riêng, vui lòng liên hệ để được hỗ trợ.');
  const sub = await getSubscription(db, i.tenantId);
  const trial = (await db.query('SELECT status FROM tenant WHERE id=$1 AND deleted_at IS NULL', [i.tenantId])).rows[0];
  if (!trial) throw new PlatformError('Không tìm thấy cửa hàng.');
  const periodStart = sub?.period_end && sub.period_end.getTime() > now.getTime() ? sub.period_end : now;
  const periodEnd = addCycle(periodStart, i.cycle);
  const subtotal = planPrice(plan, i.cycle);
  let rule = null;
  let couponCode: string | null = null;
  if (i.couponCode?.trim()) {
    const c = await findCoupon(db, i.couponCode, plan.code, now);
    rule = { percentOff: c.percent_off, amountOff: c.amount_off === null ? null : Number(c.amount_off) };
    couponCode = c.code;
  }
  const { discount, total } = applyCoupon(subtotal, rule);
  const creditUsed = Math.min(Number(sub?.credit ?? 0), total);
  return { plan, cycle: i.cycle, subtotal, discount, creditUsed, amount: total - creditUsed, periodStart, periodEnd, couponCode };
}

export interface InvoiceRow {
  id: string; tenant_id: string; number: string; kind: 'SUBSCRIPTION' | 'UPGRADE'; plan_code: string; plan_name: string; cycle: Cycle;
  period_start: Date; period_end: Date; subtotal: string; discount: string; credit_used: string; amount: string; status: 'OPEN' | 'PAID' | 'VOID';
  pay_code: string; provider: string | null; provider_ref: string | null; checkout_url: string | null; order_code: string | null;
  note: string | null; created_at: Date; due_at: Date | null; paid_at: Date | null; paid_by: string | null; coupon_code: string | null;
}

const INVOICE_SELECT = `SELECT i.*, p.code AS plan_code, p.name AS plan_name, c.code AS coupon_code
  FROM invoice i JOIN plan p ON p.id = i.plan_id LEFT JOIN coupon c ON c.id = i.coupon_id`;

export async function getInvoice(db: Db, id: string): Promise<InvoiceRow | null> {
  return (await db.query(`${INVOICE_SELECT} WHERE i.id=$1`, [id])).rows[0] ?? null;
}

export async function listInvoices(pool: Pool, f: { tenantId?: string; status?: string; limit?: number } = {}): Promise<(InvoiceRow & { tenant_name: string; tenant_slug: string })[]> {
  const r = await pool.query(
    `SELECT i.*, p.code AS plan_code, p.name AS plan_name, c.code AS coupon_code, t.name AS tenant_name, t.slug AS tenant_slug
     FROM invoice i JOIN plan p ON p.id = i.plan_id JOIN tenant t ON t.id = i.tenant_id LEFT JOIN coupon c ON c.id = i.coupon_id
     WHERE ($1::uuid IS NULL OR i.tenant_id=$1) AND ($2::text IS NULL OR i.status=$2) ORDER BY i.created_at DESC LIMIT $3`,
    [f.tenantId ?? null, f.status ?? null, f.limit ?? 100]);
  return r.rows;
}

async function nextInvoiceNumber(db: Db, now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  const n = (await db.query(
    `INSERT INTO invoice_counter(year,last_value) VALUES ($1,1) ON CONFLICT (year) DO UPDATE SET last_value = invoice_counter.last_value + 1 RETURNING last_value`, [year])).rows[0].last_value as number;
  return `HD-${year}-${String(n).padStart(5, '0')}`;
}

/**
 * Tạo hóa đơn mua/gia hạn. Hóa đơn đang mở của tenant bị hủy để chỉ còn một hóa đơn cần trả; nếu giống hệt thì dùng lại (bấm đúp không sinh thêm).
 */
export async function createSubscriptionInvoice(pool: Pool, actor: Actor, i: { tenantId: string; planCode: string; cycle: string; couponCode?: string | null }, now = new Date()): Promise<InvoiceRow> {
  return platformTx(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invoice:${i.tenantId}`]);
    const q = await quoteSubscription(db, i, now);
    const open = (await db.query(`${INVOICE_SELECT} WHERE i.tenant_id=$1 AND i.status='OPEN' AND i.kind='SUBSCRIPTION'`, [i.tenantId])).rows as InvoiceRow[];
    const same = open.find((o) => o.plan_code === q.plan.code && o.cycle === q.cycle && Number(o.amount) === q.amount && (o.coupon_code ?? null) === q.couponCode
      && o.period_start.getTime() === q.periodStart.getTime());
    if (same) return same;
    if (open.length) await db.query("UPDATE invoice SET status='VOID', note=COALESCE(note,'') || ' [thay bằng hóa đơn mới]' WHERE tenant_id=$1 AND status='OPEN' AND kind='SUBSCRIPTION'", [i.tenantId]);
    const coupon = q.couponCode ? (await db.query('SELECT id FROM coupon WHERE code=$1', [q.couponCode])).rows[0].id : null;
    const number = await nextInvoiceNumber(db, now);
    const id = (await db.query(
      `INSERT INTO invoice(tenant_id,number,kind,plan_id,cycle,period_start,period_end,subtotal,discount,credit_used,amount,coupon_id,pay_code,due_at)
       VALUES ($1,$2,'SUBSCRIPTION',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [i.tenantId, number, q.plan.id, q.cycle, q.periodStart, q.periodEnd, q.subtotal, q.discount, q.creditUsed, q.amount, coupon, newPayCode((n) => randomBytes(n)), q.periodStart],
    )).rows[0].id as string;
    await platformAudit(db, actor, 'invoice.create', i.tenantId, { number, plan: q.plan.code, cycle: q.cycle, amount: q.amount });
    return (await getInvoice(db, id))!;
  });
}

export interface UpgradeQuote { plan: PlanRow; proration: Proration; periodStart: Date; periodEnd: Date; cycle: Cycle; direction: 'UP' | 'DOWN' | 'SAME' }

export async function quotePlanChange(db: Db, tenantId: string, planCode: string, now = new Date()): Promise<UpgradeQuote> {
  const sub = await getSubscription(db, tenantId);
  if (!sub || !sub.period_end || sub.period_end.getTime() <= now.getTime()) throw new PlatformError('Chỉ đổi gói giữa kỳ khi đang có thuê bao còn hạn. Hãy mua/gia hạn gói mới.');
  const plan = await getPlan(db, planCode);
  if (!isSelfServePlan(plan)) throw new PlatformError('Gói này báo giá riêng, vui lòng liên hệ để được hỗ trợ.');
  const cur = await getPlan(db, sub.plan_code);
  const oldPrice = planPrice(cur, sub.cycle);
  const newPrice = planPrice(plan, sub.cycle);
  const proration = prorateChange({ oldPrice, newPrice, periodStart: sub.period_start, periodEnd: sub.period_end, now });
  return { plan, proration, periodStart: sub.period_start, periodEnd: sub.period_end, cycle: sub.cycle, direction: newPrice > oldPrice ? 'UP' : newPrice < oldPrice ? 'DOWN' : 'SAME' };
}

/** Nâng gói giữa kỳ: hóa đơn chênh lệch theo ngày còn lại; gói đổi khi hóa đơn được thanh toán. Hạ gói áp dụng ngay (phần dư thành số dư cho kỳ sau). */
export async function changePlanMidTerm(pool: Pool, actor: Actor, tenantId: string, planCode: string, now = new Date()): Promise<{ invoice: InvoiceRow | null; applied: boolean; creditLeft: number }> {
  return platformTx(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invoice:${tenantId}`]);
    const q = await quotePlanChange(db, tenantId, planCode, now);
    const sub = (await getSubscription(db, tenantId))!;
    if (q.direction === 'SAME') throw new PlatformError('Đang dùng gói này rồi.');
    if (q.direction === 'DOWN' || q.proration.amountDue === 0) {
      await db.query('UPDATE subscription SET plan_id=$2, credit = credit + $3, mrr=$4, updated_at=now() WHERE tenant_id=$1',
        [tenantId, q.plan.id, q.proration.creditLeft, mrrOf(planPrice(q.plan, q.cycle), q.cycle)]);
      await db.query('UPDATE tenant SET plan_id=$2 WHERE id=$1', [tenantId, q.plan.id]);
      await db.query(`INSERT INTO subscription_event(tenant_id,kind,plan_code,cycle,mrr,amount,period_end,data) VALUES ($1,'DOWNGRADE',$2,$3,$4,0,$5,$6)`,
        [tenantId, q.plan.code, q.cycle, mrrOf(planPrice(q.plan, q.cycle), q.cycle), q.periodEnd, JSON.stringify({ from: sub.plan_code, creditLeft: q.proration.creditLeft })]);
      await platformAudit(db, actor, 'subscription.downgrade', tenantId, { from: sub.plan_code, to: q.plan.code, creditLeft: q.proration.creditLeft });
      return { invoice: null, applied: true, creditLeft: q.proration.creditLeft };
    }
    await db.query("UPDATE invoice SET status='VOID', note=COALESCE(note,'') || ' [thay bằng hóa đơn nâng cấp mới]' WHERE tenant_id=$1 AND status='OPEN' AND kind='UPGRADE'", [tenantId]);
    const number = await nextInvoiceNumber(db, now);
    const id = (await db.query(
      `INSERT INTO invoice(tenant_id,number,kind,plan_id,cycle,period_start,period_end,subtotal,discount,credit_used,amount,pay_code,due_at,data)
       VALUES ($1,$2,'UPGRADE',$3,$4,$5,$6,$7,0,0,$7,$8,$9,$10) RETURNING id`,
      [tenantId, number, q.plan.id, q.cycle, q.periodStart, q.periodEnd, q.proration.amountDue, newPayCode((n) => randomBytes(n)), now, JSON.stringify({ proration: q.proration, from: sub.plan_code })],
    )).rows[0].id as string;
    await platformAudit(db, actor, 'invoice.create', tenantId, { number, kind: 'UPGRADE', to: q.plan.code, amount: q.proration.amountDue });
    return { invoice: (await getInvoice(db, id))!, applied: false, creditLeft: 0 };
  });
}

/** Gắn thông tin cổng thanh toán vào hóa đơn (mã đơn PayOS, liên kết). Mỗi lần tạo liên kết lấy mã đơn mới. */
export async function nextOrderCode(pool: Pool, invoiceId: string): Promise<number> {
  const r = await pool.query("UPDATE invoice SET order_code = nextval('invoice_order_seq') WHERE id=$1 AND status='OPEN' RETURNING order_code", [invoiceId]);
  if (!r.rows[0]) throw new PlatformError('Hóa đơn không còn mở để thanh toán.');
  return Number(r.rows[0].order_code);
}

export async function attachPayment(pool: Pool, invoiceId: string, s: { provider: 'PAYOS' | 'VIETQR'; providerRef?: string | null; checkoutUrl?: string | null }): Promise<void> {
  await pool.query("UPDATE invoice SET provider=$2, provider_ref=$3, checkout_url=$4 WHERE id=$1 AND status='OPEN'", [invoiceId, s.provider, s.providerRef ?? null, s.checkoutUrl ?? null]);
}

export async function voidInvoice(pool: Pool, actor: Actor, invoiceId: string, reason: string): Promise<void> {
  if (reason.trim().length < 3) throw new PlatformError('Nhập lý do hủy hóa đơn.');
  const r = await pool.query("UPDATE invoice SET status='VOID', note=$2 WHERE id=$1 AND status='OPEN' RETURNING tenant_id", [invoiceId, reason.trim()]);
  if (!r.rows[0]) throw new PlatformError('Chỉ hủy được hóa đơn đang mở.');
  await platformAudit(pool, actor, 'invoice.void', r.rows[0].tenant_id, { invoiceId }, reason.trim());
}

export interface PaidInput { invoiceId?: string; orderCode?: number; payCode?: string; by: string; provider: 'PAYOS' | 'VIETQR' | 'MANUAL'; eventId?: string; paidAt?: Date; amount?: number }
export interface PaidResult { invoiceId: string; tenantId: string; already: boolean }

/**
 * Ghi nhận hóa đơn đã thanh toán và kích hoạt thuê bao. Idempotent: gọi lại (webhook gửi trùng, bấm đúp) không cộng thêm kỳ.
 * Webhook phải khớp số tiền hóa đơn; chênh lệch KHÔNG kích hoạt (để quản trị viên xem).
 */
interface PaidReject { reject: { action: string; tenantId: string; data: object; message: string } }

export async function markInvoicePaid(pool: Pool, actor: Actor, i: PaidInput, now = new Date()): Promise<PaidResult> {
  const res = await platformTx<PaidResult | PaidReject>(pool, async (db) => {
    const where = i.invoiceId ? ['i.id=$1', i.invoiceId] : i.orderCode ? ['i.order_code=$1', i.orderCode] : i.payCode ? ['i.pay_code=$1', i.payCode] : null;
    if (!where) throw new PlatformError('Thiếu mã hóa đơn.');
    const inv = (await db.query(`SELECT i.*, p.code AS plan_code, p.price_month::int, p.price_year::int FROM invoice i JOIN plan p ON p.id=i.plan_id WHERE ${where[0]} FOR UPDATE OF i`, [where[1]])).rows[0];
    if (!inv) throw new PlatformError('Không tìm thấy hóa đơn.');
    if (i.eventId) {
      const fresh = await db.query('INSERT INTO billing_event(provider,event_id,invoice_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [i.provider, i.eventId, inv.id]);
      if (!fresh.rowCount) return { invoiceId: inv.id, tenantId: inv.tenant_id, already: true };
    }
    if (inv.status === 'PAID') return { invoiceId: inv.id, tenantId: inv.tenant_id, already: true };
    if (inv.status === 'VOID') {
      return { reject: { action: 'billing.paid_void_invoice', tenantId: inv.tenant_id as string, data: { invoice: inv.number, eventId: i.eventId, amount: i.amount }, message: 'Hóa đơn đã bị hủy; khoản thanh toán cần được xem xét thủ công.' } };
    }
    if (i.amount !== undefined && i.amount !== Number(inv.amount)) {
      return { reject: { action: 'billing.amount_mismatch', tenantId: inv.tenant_id as string, data: { invoice: inv.number, expected: Number(inv.amount), got: i.amount, eventId: i.eventId }, message: `Số tiền nhận (${i.amount}) khác hóa đơn (${inv.amount}); cần xác nhận thủ công.` } };
    }
    const paidAt = i.paidAt ?? now;
    await db.query('UPDATE invoice SET status=$2, paid_at=$3, paid_by=$4, provider=COALESCE(provider,$5) WHERE id=$1', [inv.id, 'PAID', paidAt, i.by, i.provider]);
    const cycle = inv.cycle as Cycle;
    const tenantId = inv.tenant_id as string;
    const plan = { price_month: inv.price_month, price_year: inv.price_year };
    const sub = (await db.query('SELECT * FROM subscription WHERE tenant_id=$1 FOR UPDATE', [tenantId])).rows[0];

    if (inv.kind === 'UPGRADE') {
      if (!sub) throw new PlatformError('Hóa đơn nâng cấp nhưng tenant chưa có thuê bao.');
      const mrr = mrrOf(planPrice(plan, cycle), cycle);
      await db.query('UPDATE subscription SET plan_id=$2, price_paid = price_paid + $3, mrr=$4, updated_at=now() WHERE tenant_id=$1', [tenantId, inv.plan_id, inv.amount, mrr]);
      await db.query('UPDATE tenant SET plan_id=$2 WHERE id=$1', [tenantId, inv.plan_id]);
      await db.query(`INSERT INTO subscription_event(tenant_id,kind,plan_code,cycle,mrr,amount,period_end,invoice_id) VALUES ($1,'UPGRADE',$2,$3,$4,$5,$6,$7)`,
        [tenantId, inv.plan_code, cycle, mrr, inv.amount, sub.period_end, inv.id]);
    } else {
      const mrr = mrrOf(Number(inv.subtotal) - Number(inv.discount), cycle);
      await db.query(
        `INSERT INTO subscription(tenant_id,plan_id,cycle,period_start,period_end,price_paid,mrr,credit) VALUES ($1,$2,$3,$4,$5,$6,$7,0)
         ON CONFLICT (tenant_id) DO UPDATE SET plan_id=EXCLUDED.plan_id, cycle=EXCLUDED.cycle, period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end,
           price_paid=EXCLUDED.price_paid, mrr=EXCLUDED.mrr, credit = subscription.credit - $8, updated_at=now()`,
        [tenantId, inv.plan_id, cycle, inv.period_start, inv.period_end, inv.amount, mrr, inv.credit_used]);
      await db.query('UPDATE tenant SET plan_id=$2 WHERE id=$1', [tenantId, inv.plan_id]);
      const t = (await db.query('SELECT status, locked_by_billing FROM tenant WHERE id=$1', [tenantId])).rows[0];
      const reopened = t.status === 'TRIAL' || (t.locked_by_billing && (t.status === 'READ_ONLY' || t.status === 'SUSPENDED'));
      if (reopened) await db.query("UPDATE tenant SET status='ACTIVE', locked_by_billing=false WHERE id=$1", [tenantId]);
      const kind = !sub ? 'ACTIVATE' : t.locked_by_billing ? 'REACTIVATE' : 'RENEW';
      await db.query(`INSERT INTO subscription_event(tenant_id,kind,plan_code,cycle,mrr,amount,period_end,invoice_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, kind, inv.plan_code, cycle, mrr, inv.amount, inv.period_end, inv.id]);
    }
    if (inv.coupon_id) await db.query('UPDATE coupon SET redeemed = redeemed + 1 WHERE id=$1', [inv.coupon_id]);
    await platformAudit(db, actor, 'invoice.paid', tenantId, { invoice: inv.number, amount: Number(inv.amount), provider: i.provider, by: i.by });
    for (const to of await ownerEmails(db, tenantId)) {
      await queueEmail(db, { tenantId, kind: 'invoice.paid', to, subject: `Đã nhận thanh toán ${inv.number}`,
        body: `Cảm ơn bạn. Hóa đơn ${inv.number} (${Number(inv.amount).toLocaleString('vi-VN')} đ) đã được ghi nhận. Gói hiện tại có hiệu lực đến ${new Date(inv.period_end).toLocaleDateString('vi-VN')}.` });
    }
    return { invoiceId: inv.id as string, tenantId, already: false };
  });
  if ('reject' in res) {
    // Ghi dấu vết NGOÀI giao dịch đã hoàn tác (nếu không, lỗi sẽ cuốn theo cả nhật ký)
    await platformAudit(pool, actor, res.reject.action, res.reject.tenantId, res.reject.data);
    throw new PlatformError(res.reject.message);
  }
  return res;
}

/** Gia hạn/kích hoạt thủ công (hợp đồng ký ngoài): đặt gói, chu kỳ và ngày hết hạn tùy ý; `endsAt` null = không thời hạn. */
export async function extendSubscriptionManual(pool: Pool, actor: Actor, i: { tenantId: string; planCode: string; cycle: string; endsAt: Date | null; amount?: number; note?: string }, now = new Date()): Promise<void> {
  if (!isCycle(i.cycle)) throw new PlatformError('Chu kỳ phải là tháng hoặc năm.');
  const cycle: Cycle = i.cycle;
  if (i.endsAt && i.endsAt.getTime() <= now.getTime()) throw new PlatformError('Ngày hết hạn phải ở tương lai.');
  if (i.amount !== undefined && (!Number.isInteger(i.amount) || i.amount < 0)) throw new PlatformError('Số tiền phải là số nguyên không âm.');
  await platformTx(pool, async (db) => {
    const plan = await getPlan(db, i.planCode);
    const t = (await db.query('SELECT status, locked_by_billing FROM tenant WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [i.tenantId])).rows[0];
    if (!t) throw new PlatformError('Không tìm thấy khách hàng.');
    const existing = await getSubscription(db, i.tenantId);
    const price = i.amount ?? 0;
    const mrr = mrrOf(price, cycle);
    await db.query(
      `INSERT INTO subscription(tenant_id,plan_id,cycle,period_start,period_end,price_paid,mrr,credit) VALUES ($1,$2,$3,$4,$5,$6,$7,0)
       ON CONFLICT (tenant_id) DO UPDATE SET plan_id=EXCLUDED.plan_id, cycle=EXCLUDED.cycle, period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end,
         price_paid=EXCLUDED.price_paid, mrr=EXCLUDED.mrr, updated_at=now()`,
      [i.tenantId, plan.id, cycle, now, i.endsAt, price, mrr]);
    await db.query('UPDATE tenant SET plan_id=$2 WHERE id=$1', [i.tenantId, plan.id]);
    if (t.status === 'TRIAL' || (t.locked_by_billing && (t.status === 'READ_ONLY' || t.status === 'SUSPENDED'))) {
      await db.query("UPDATE tenant SET status='ACTIVE', locked_by_billing=false WHERE id=$1", [i.tenantId]);
    }
    await db.query(`INSERT INTO subscription_event(tenant_id,kind,plan_code,cycle,mrr,amount,period_end,data) VALUES ($1,'MANUAL',$2,$3,$4,$5,$6,$7)`,
      [i.tenantId, plan.code, cycle, mrr, price, i.endsAt, JSON.stringify({ wasNew: !existing, note: i.note ?? null })]);
    await platformAudit(db, actor, 'subscription.manual', i.tenantId, { plan: plan.code, cycle: i.cycle, endsAt: i.endsAt?.toISOString() ?? null, amount: price }, i.note);
  });
}

// ===== Vòng đời hết hạn =====
export interface SweepResult { readOnly: string[]; suspended: string[]; reopened: string[]; reminders: number }

/**
 * Quét định kỳ (worker): chuyển chỉ đọc / khóa tenant hết hạn thuê bao hoặc dùng thử, mở lại khi đã gia hạn, xếp thư nhắc 7 ngày / 1 ngày / hết hạn.
 * Không bao giờ xóa dữ liệu. Tenant bị admin khóa tay (locked_by_billing = false) không bị quét đụng tới.
 */
export async function sweepSubscriptions(pool: Pool, now = new Date()): Promise<SweepResult> {
  const out: SweepResult = { readOnly: [], suspended: [], reopened: [], reminders: 0 };
  const cfg = await getBillingConfig(pool);
  const rows = (await pool.query(
    `SELECT t.id, t.slug, t.name, t.status, t.locked_by_billing, t.trial_ends_at, s.period_end, (s.tenant_id IS NOT NULL) AS has_sub
     FROM tenant t LEFT JOIN subscription s ON s.tenant_id = t.id
     WHERE t.deleted_at IS NULL AND ((t.status = 'TRIAL' AND t.trial_ends_at IS NOT NULL) OR s.tenant_id IS NOT NULL)`)).rows;
  for (const t of rows) {
    const manualLock = (t.status === 'READ_ONLY' || t.status === 'SUSPENDED') && !t.locked_by_billing;
    if (manualLock) continue;
    const endsAt: Date | null = t.has_sub ? t.period_end : t.trial_ends_at;
    const { phase } = subscriptionPhase(now, endsAt, cfg);
    const target = statusForPhase(phase);
    if (target && t.status !== target) {
      await platformTx(pool, async (db) => {
        await db.query('UPDATE tenant SET status=$2, locked_by_billing=true WHERE id=$1', [t.id, target]);
        await db.query('INSERT INTO subscription_event(tenant_id,kind,data) VALUES ($1,$2,$3)', [t.id, target === 'READ_ONLY' ? 'READ_ONLY' : 'SUSPEND', JSON.stringify({ endsAt })]);
        await platformAudit(db, SYSTEM_ACTOR, `billing.${target.toLowerCase()}`, t.id, { endsAt });
        for (const to of await ownerEmails(db, t.id)) {
          await queueEmail(db, { tenantId: t.id, kind: `billing.${target.toLowerCase()}`, to,
            subject: target === 'READ_ONLY' ? `${t.name}: tài khoản đã chuyển sang chế độ chỉ đọc` : `${t.name}: tài khoản đã bị tạm khóa`,
            body: target === 'READ_ONLY'
              ? 'Gói dịch vụ đã hết hạn. Bạn vẫn xem và xuất dữ liệu được nhưng chưa tạo/sửa được. Gia hạn để dùng lại ngay; dữ liệu của bạn được giữ nguyên.'
              : 'Gói dịch vụ đã hết hạn quá lâu nên tài khoản bị tạm khóa. Dữ liệu vẫn được giữ; gia hạn hoặc liên hệ để mở lại.' });
        }
      });
      (target === 'READ_ONLY' ? out.readOnly : out.suspended).push(t.id);
      continue;
    }
    if (!target && t.locked_by_billing && (t.status === 'READ_ONLY' || t.status === 'SUSPENDED')) {
      // Hạn mới được đặt (gia hạn bằng đường khác) mà trạng thái chưa mở lại
      await pool.query("UPDATE tenant SET status=$2, locked_by_billing=false WHERE id=$1", [t.id, t.has_sub ? 'ACTIVE' : 'TRIAL']);
      await pool.query("INSERT INTO subscription_event(tenant_id,kind) VALUES ($1,'REACTIVATE')", [t.id]);
      out.reopened.push(t.id);
    }
    if (endsAt && (phase === 'ACTIVE' || phase === 'GRACE')) {
      const sent = (await pool.query('SELECT slot FROM renewal_reminder WHERE tenant_id=$1 AND period_end=$2', [t.id, endsAt])).rows.map((r: { slot: number }) => r.slot);
      const slot = dueRenewalReminder(now, endsAt, sent);
      if (slot !== null) {
        const ins = await pool.query('INSERT INTO renewal_reminder(tenant_id,period_end,slot) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [t.id, endsAt, slot]);
        if (ins.rowCount) {
          const when = endsAt.toLocaleDateString('vi-VN');
          for (const to of await ownerEmails(pool, t.id)) {
            await queueEmail(pool, { tenantId: t.id, kind: 'billing.reminder', to,
              subject: slot === 0 ? `${t.name}: gói dịch vụ đã hết hạn` : `${t.name}: gói dịch vụ sắp hết hạn (${slot === 1 ? 'còn 1 ngày' : 'còn 7 ngày'})`,
              body: slot === 0 ? `Gói dịch vụ hết hạn ngày ${when}. Vào Cài đặt → Gói dịch vụ để gia hạn trước khi tài khoản chuyển sang chỉ đọc.`
                : `Gói dịch vụ sẽ hết hạn ngày ${when}. Vào Cài đặt → Gói dịch vụ để gia hạn.` });
          }
          out.reminders++;
        }
      }
    }
  }
  return out;
}

// ===== Số liệu kinh doanh =====
export interface BusinessMetrics {
  mrr: number; arr: number; payingTenants: number;
  byPlan: { plan: string; name: string; tenants: number; trial: number; mrr: number }[];
  newCustomers: number; churned: number; trialStarted: number; trialConverted: number; conversionRate: number | null;
  revenueByMonth: { month: string; revenue: number }[];
  expiringSoon: { id: string; slug: string; name: string; plan: string; status: string; endsAt: Date; kind: 'TRIAL' | 'PAID' }[];
}

/** MRR = tổng mrr thuê bao của tenant đang ACTIVE (kể cả đang ân hạn). Khách mới/rời bỏ/chuyển đổi tính theo lịch sử sự kiện trong khoảng. */
export async function businessMetrics(pool: Pool, range: { from: Date; to: Date }, now = new Date()): Promise<BusinessMetrics> {
  const mrrRow = (await pool.query(
    `SELECT COALESCE(sum(s.mrr),0)::bigint AS mrr, count(*)::int AS n FROM subscription s JOIN tenant t ON t.id=s.tenant_id
     WHERE t.deleted_at IS NULL AND t.status='ACTIVE'`)).rows[0];
  const byPlan = (await pool.query(
    `SELECT p.code AS plan, p.name, count(*) FILTER (WHERE t.status='ACTIVE')::int AS tenants, count(*) FILTER (WHERE t.status='TRIAL')::int AS trial,
            COALESCE(sum(s.mrr) FILTER (WHERE t.status='ACTIVE'),0)::bigint AS mrr
     FROM plan p LEFT JOIN tenant t ON t.plan_id=p.id AND t.deleted_at IS NULL LEFT JOIN subscription s ON s.tenant_id=t.id
     GROUP BY p.code, p.name, p.price_month ORDER BY p.price_month`)).rows;
  const ev = (await pool.query(
    `SELECT count(DISTINCT tenant_id) FILTER (WHERE kind='ACTIVATE') AS activated,
            count(DISTINCT tenant_id) FILTER (WHERE kind IN ('READ_ONLY','SUSPEND')) AS churned,
            count(DISTINCT tenant_id) FILTER (WHERE kind='TRIAL_START') AS trials
     FROM subscription_event WHERE at >= $1 AND at < $2`, [range.from, range.to])).rows[0];
  const conv = (await pool.query(
    `SELECT count(*)::int AS started, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscription_event a WHERE a.tenant_id=s.tenant_id AND a.kind='ACTIVATE' AND a.at >= s.at))::int AS converted
     FROM subscription_event s WHERE s.kind='TRIAL_START' AND s.at >= $1 AND s.at < $2`, [range.from, range.to])).rows[0];
  const revenue = (await pool.query(
    `SELECT to_char(date_trunc('month', paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM') AS month, sum(amount)::bigint AS revenue
     FROM invoice WHERE status='PAID' AND paid_at >= $1 GROUP BY 1 ORDER BY 1`, [new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() + 1, 1))])).rows;
  const expiring = (await pool.query(
    `SELECT t.id, t.slug, t.name, p.code AS plan, t.status, COALESCE(s.period_end, t.trial_ends_at) AS ends_at, (s.tenant_id IS NULL) AS is_trial
     FROM tenant t JOIN plan p ON p.id=t.plan_id LEFT JOIN subscription s ON s.tenant_id=t.id
     WHERE t.deleted_at IS NULL AND t.status IN ('TRIAL','ACTIVE') AND COALESCE(s.period_end, t.trial_ends_at) BETWEEN $1 AND $2 ORDER BY 6`,
    [now, new Date(now.getTime() + 14 * 86_400_000)])).rows;
  return {
    mrr: Number(mrrRow.mrr), arr: Number(mrrRow.mrr) * 12, payingTenants: mrrRow.n,
    byPlan: byPlan.map((r) => ({ ...r, mrr: Number(r.mrr) })),
    newCustomers: Number(ev.activated), churned: Number(ev.churned), trialStarted: conv.started, trialConverted: conv.converted,
    conversionRate: conv.started > 0 ? conv.converted / conv.started : null,
    revenueByMonth: revenue.map((r) => ({ month: r.month, revenue: Number(r.revenue) })),
    expiringSoon: expiring.map((r) => ({ id: r.id, slug: r.slug, name: r.name, plan: r.plan, status: r.status, endsAt: r.ends_at, kind: r.is_trial ? 'TRIAL' as const : 'PAID' as const })),
  };
}
