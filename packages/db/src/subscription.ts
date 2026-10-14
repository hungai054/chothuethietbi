import { DEFAULT_LIFECYCLE, ForbiddenError, planPrice, subscriptionPhase, zonedTimeToUtc, type Cycle, type Phase } from '@rentpro/core';
import { nearLimit, type LimitKey } from '@rentpro/tenancy';
import type { ServiceCtx } from './service';

const needBilling = (ctx: ServiceCtx) => { if (!ctx.permissions.has('billing.manage')) throw new ForbiddenError('billing.manage'); };

/**
 * Phía cửa hàng của thuê bao: CHỈ ĐỌC (role ứng dụng, RLS). Việc tạo hóa đơn/ghi nhận tiền đi qua billing.ts bằng role quản trị
 * sau khi trang đã kiểm quyền `billing.manage`, nên vẫn dùng được khi tài khoản đang ở chế độ chỉ đọc.
 */
export interface MyInvoice {
  id: string; number: string; kind: 'SUBSCRIPTION' | 'UPGRADE'; planCode: string; planName: string; cycle: Cycle; periodStart: Date; periodEnd: Date;
  amount: number; discount: number; status: 'OPEN' | 'PAID' | 'VOID'; payCode: string; provider: string | null; checkoutUrl: string | null; createdAt: Date; paidAt: Date | null;
}

export interface UsageLine { key: LimitKey; label: string; used: number; limit: number | null; near: boolean; over: boolean }

export interface MySubscription {
  tenantStatus: string;
  plan: { code: string; name: string; priceMonth: number; priceYear: number };
  subscription: { cycle: Cycle; periodStart: Date; periodEnd: Date | null; pricePaid: number; credit: number } | null;
  trialEndsAt: Date | null;
  /** Hạn đang áp dụng: kỳ thuê bao, hoặc hết dùng thử nếu chưa trả tiền; null = không thời hạn */
  endsAt: Date | null;
  phase: Phase;
  readOnlyAt: Date | null;
  suspendAt: Date | null;
  daysLeft: number | null;
  invoices: MyInvoice[];
  usage: UsageLine[];
  plans: { code: string; name: string; priceMonth: number; priceYear: number; selfServe: boolean }[];
}

const DAY = 86_400_000;

export async function tenantUsage(ctx: ServiceCtx, now = new Date()): Promise<UsageLine[]> {
  const one = async (sql: string, args: unknown[] = []) => (await ctx.db.query(sql, args)).rows[0].n as number;
  const tz = ctx.timezone ?? 'Asia/Ho_Chi_Minh';
  const ym = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(now);
  const monthStart = zonedTimeToUtc(`${ym}-01T00:00`, tz)!;
  const used: Record<LimitKey, number> = {
    branches: await one('SELECT count(*)::int n FROM branch WHERE deleted_at IS NULL'),
    users: await one('SELECT count(*)::int n FROM app_user WHERE active'),
    equipment: await one('SELECT count(*)::int n FROM equipment_unit WHERE deleted_at IS NULL'),
    messages_per_month: await one("SELECT count(*)::int n FROM notification_log WHERE status='SENT' AND scope='SHARED' AND sent_at >= $1", [monthStart]),
    storage_mb: 0,
  };
  const labels: Record<LimitKey, string> = { branches: 'Chi nhánh', users: 'Người dùng', equipment: 'Thiết bị', messages_per_month: 'Tin nhắn dùng chung/tháng', storage_mb: 'Dung lượng (MB)' };
  return (Object.keys(labels) as LimitKey[])
    .filter((k) => k !== 'storage_mb')
    .map((k) => ({ key: k, label: labels[k], used: used[k], limit: ctx.limits[k], near: nearLimit(ctx.limits, k, used[k]), over: ctx.limits[k] !== null && used[k] > (ctx.limits[k] as number) }));
}

/** Trang "Gói dịch vụ" của cửa hàng. Xem được cả khi chỉ đọc. */
export async function getMySubscription(ctx: ServiceCtx, now = new Date()): Promise<MySubscription> {
  // Không dùng guard(feature): thuê bao có ở mọi gói; chỉ cần quyền billing.manage
  needBilling(ctx);
  const t = (await ctx.db.query(
    `SELECT t.status, t.trial_ends_at, p.code, p.name, p.price_month::int AS pm, p.price_year::int AS py FROM tenant t JOIN plan p ON p.id = t.plan_id`)).rows[0];
  const sub = (await ctx.db.query('SELECT cycle, period_start, period_end, price_paid::bigint, credit::bigint FROM subscription')).rows[0];
  const cfgRaw = (await ctx.db.query("SELECT value FROM platform_setting WHERE key='billing'")).rows[0]?.value ?? {};
  const cfg = { ...DEFAULT_LIFECYCLE, graceDays: cfgRaw.graceDays ?? DEFAULT_LIFECYCLE.graceDays, lockDays: cfgRaw.lockDays ?? DEFAULT_LIFECYCLE.lockDays };
  const endsAt: Date | null = sub ? sub.period_end : t.trial_ends_at;
  const { phase, readOnlyAt, suspendAt } = subscriptionPhase(now, endsAt, cfg);
  const invoices = (await ctx.db.query(
    `SELECT i.id, i.number, i.kind, p.code AS plan_code, p.name AS plan_name, i.cycle, i.period_start, i.period_end, i.amount::bigint, i.discount::bigint, i.status,
            i.pay_code, i.provider, i.checkout_url, i.created_at, i.paid_at
     FROM invoice i JOIN plan p ON p.id = i.plan_id ORDER BY i.created_at DESC LIMIT 50`)).rows;
  const plans = (await ctx.db.query('SELECT code, name, price_month::int AS pm, price_year::int AS py, is_custom FROM plan ORDER BY price_month')).rows;
  return {
    tenantStatus: t.status,
    plan: { code: t.code, name: t.name, priceMonth: t.pm, priceYear: t.py },
    subscription: sub ? { cycle: sub.cycle, periodStart: sub.period_start, periodEnd: sub.period_end, pricePaid: Number(sub.price_paid), credit: Number(sub.credit) } : null,
    trialEndsAt: t.trial_ends_at, endsAt, phase, readOnlyAt, suspendAt,
    daysLeft: endsAt ? Math.ceil((endsAt.getTime() - now.getTime()) / DAY) : null,
    invoices: invoices.map((r) => ({
      id: r.id, number: r.number, kind: r.kind, planCode: r.plan_code, planName: r.plan_name, cycle: r.cycle, periodStart: r.period_start, periodEnd: r.period_end,
      amount: Number(r.amount), discount: Number(r.discount), status: r.status, payCode: r.pay_code, provider: r.provider, checkoutUrl: r.checkout_url, createdAt: r.created_at, paidAt: r.paid_at,
    })),
    usage: await tenantUsage(ctx, now),
    plans: plans.map((p) => ({ code: p.code, name: p.name, priceMonth: p.pm, priceYear: p.py, selfServe: !p.is_custom && p.pm > 0 })),
  };
}

/** Giá hiển thị theo chu kỳ (dùng trong form chọn gói). */
export const priceOf = (p: { priceMonth: number; priceYear: number }, cycle: Cycle) => planPrice({ price_month: p.priceMonth, price_year: p.priceYear }, cycle);

/** Một hóa đơn của chính cửa hàng (kiểm tra quyền sở hữu trước khi hiện QR/thanh toán). */
export async function getMyInvoice(ctx: ServiceCtx, invoiceId: string): Promise<MyInvoice | null> {
  needBilling(ctx);
  const r = await getMySubscriptionInvoices(ctx, invoiceId);
  return r[0] ?? null;
}

async function getMySubscriptionInvoices(ctx: ServiceCtx, invoiceId: string): Promise<MyInvoice[]> {
  const rows = (await ctx.db.query(
    `SELECT i.id, i.number, i.kind, p.code AS plan_code, p.name AS plan_name, i.cycle, i.period_start, i.period_end, i.amount::bigint, i.discount::bigint, i.status,
            i.pay_code, i.provider, i.checkout_url, i.created_at, i.paid_at
     FROM invoice i JOIN plan p ON p.id = i.plan_id WHERE i.id=$1`, [invoiceId])).rows;
  return rows.map((r) => ({
    id: r.id, number: r.number, kind: r.kind, planCode: r.plan_code, planName: r.plan_name, cycle: r.cycle, periodStart: r.period_start, periodEnd: r.period_end,
    amount: Number(r.amount), discount: Number(r.discount), status: r.status, payCode: r.pay_code, provider: r.provider, checkoutUrl: r.checkout_url, createdAt: r.created_at, paidAt: r.paid_at,
  }));
}
