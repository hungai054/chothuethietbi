import {
  AGING_BUCKETS, FEE_KINDS, reportToXlsx, FEE_KIND_LABEL, GROUP_BY_LABEL, HIGH_UTILIZATION, LOW_UTILIZATION, ORDER_STATUS_LABEL, PAYMENT_KINDS, PAYMENT_KIND_LABEL, ReportFilterError,
  UNIT_STATUSES, UNIT_STATUS_LABEL, agingBucket, describePeriod, diffStocktake, isGroupBy, localDateKey, ratio, resolveRange, roi, utilization, utilizationHint,
  type FeeKind, type GroupBy, type Permission, type ReportCard, type ReportFilter, type ReportResult, type ReportRow, type ReportSection, type ResolvedRange,
} from '@rentpro/core';
import type { FeatureKey } from '@rentpro/tenancy';
import { computeLedger } from './finance';
import { ValidationError, audit, guard, type ServiceCtx } from './service';

type Row = Record<string, any>;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTED = `('ACTIVE','RETURNED','CLOSED')`; // đơn đã giao: mới ghi nhận doanh thu

// ===== Đăng ký báo cáo (extension đăng ký thêm báo cáo riêng ở Giai đoạn 11) =====
export interface ReportDef {
  key: string;
  title: string;
  description: string;
  feature: FeatureKey;
  permission: Permission;
  /** month = mặc định từ đầu tháng; all = toàn bộ lịch sử; snapshot = ảnh chụp thời điểm hiện tại, không dùng bộ lọc ngày */
  range: 'month' | 'all' | 'snapshot';
  groupable?: boolean;
  branchFilter?: boolean;
  run(ctx: ServiceCtx, f: ReportFilter, now: Date): Promise<ReportResult>;
}

const REGISTRY = new Map<string, ReportDef>();
export function registerReport(def: ReportDef): void {
  if (REGISTRY.has(def.key)) throw new Error(`Báo cáo "${def.key}" đã được đăng ký.`);
  REGISTRY.set(def.key, def);
}

/** Báo cáo mà người dùng này xem được (đúng gói và đúng quyền). */
export function listReports(ctx: ServiceCtx): ReportDef[] {
  return [...REGISTRY.values()].filter((d) => ctx.permissions.has(d.permission) && ctx.features[d.feature] === true);
}
export const reportDef = (key: string): ReportDef | undefined => REGISTRY.get(key);

export async function runReport(ctx: ServiceCtx, key: string, filter: ReportFilter = {}, now = new Date()): Promise<ReportResult> {
  const def = REGISTRY.get(key);
  if (!def) throw new ValidationError('Báo cáo không tồn tại.');
  guard(ctx, def.permission, def.feature);
  for (const [k, v] of [['Chi nhánh', filter.branchId], ['Danh mục', filter.categoryId]] as const) if (v && !UUID.test(v)) throw new ReportFilterError(`${k} không hợp lệ.`);
  if (filter.groupBy !== undefined && !isGroupBy(filter.groupBy)) throw new ReportFilterError('Cách nhóm không hợp lệ.');
  return def.run(ctx, filter, now);
}

// ===== Tiện ích =====
const tzOf = (ctx: ServiceCtx) => ctx.timezone ?? 'Asia/Ho_Chi_Minh';
const n = (v: unknown) => Number(v ?? 0);
const dt = (ctx: ServiceCtx, d: Date | null) => (d ? new Intl.DateTimeFormat('vi-VN', { timeZone: tzOf(ctx), day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d) : null);
const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a + n(r[k]), 0);
const snapshotPeriod = (ctx: ServiceCtx, now: Date) => `tại ${dt(ctx, now)}`;

function range(ctx: ServiceCtx, f: ReportFilter, now: Date, def: 'month' | 'all'): ResolvedRange {
  return resolveRange({ from: f.from, to: f.to }, tzOf(ctx), now, def);
}

/** Lọc đơn theo chi nhánh (chiếc trong đơn) / danh mục (mẫu trong đơn). Đơn có ít nhất một dòng khớp thì được tính cả đơn. */
const bookingScope = (alias: string, branchArg: string, catArg: string) => `
  AND (${branchArg}::uuid IS NULL OR EXISTS (SELECT 1 FROM unit_allocation sa JOIN equipment_unit su ON su.id=sa.unit_id WHERE sa.booking_id=${alias}.id AND su.branch_id=${branchArg}))
  AND (${catArg}::uuid IS NULL OR EXISTS (SELECT 1 FROM booking_line sl JOIN equipment_model sm ON sm.id=sl.model_id WHERE sl.booking_id=${alias}.id AND sm.category_id=${catArg}))`;

const col = (key: string, label: string, type: ReportSection['columns'][number]['type'] = 'text') => ({ key, label, type });

/** Danh sách mốc (ngày hoặc tháng) liên tục trong kỳ để biểu đồ không bị đứt quãng. */
function bucketKeys(r: ResolvedRange, unit: 'day' | 'month'): string[] {
  const out: string[] = [];
  const end = Date.parse(`${r.toKey}T00:00:00Z`);
  let d = Date.parse(`${r.fromKey}T00:00:00Z`);
  while (d <= end) {
    const k = new Date(d).toISOString().slice(0, unit === 'day' ? 10 : 7);
    if (out[out.length - 1] !== k) out.push(k);
    d += DAY;
  }
  return out;
}
const bucketLabel = (k: string) => (k.length === 7 ? `${k.slice(5)}/${k.slice(0, 4)}` : k.split('-').reverse().join('/'));

// ===== 1. Dashboard =====
async function dashboard(ctx: ServiceCtx, _f: ReportFilter, now: Date): Promise<ReportResult> {
  const tz = tzOf(ctx);
  const today = localDateKey(now, tz);
  const monthStart = resolveRange({ from: `${today.slice(0, 8)}01`, to: today }, tz, now);
  const dayR = resolveRange({ from: today, to: today }, tz, now);
  const money = ctx.permissions.has('reports.finance');
  const revenue = async (r: ResolvedRange) => {
    const rent = n((await ctx.db.query(`SELECT coalesce(sum(total),0) v FROM booking WHERE deleted_at IS NULL AND status IN ${COUNTED} AND coalesce(delivered_at, starts_at) >= $1 AND coalesce(delivered_at, starts_at) < $2`, [r.from, r.to])).rows[0].v);
    const fees = n((await ctx.db.query(`SELECT coalesce(sum(f.amount),0) v FROM booking_fee f JOIN booking b ON b.id=f.booking_id WHERE f.voided_at IS NULL AND b.deleted_at IS NULL AND b.status <> 'CANCELLED' AND f.created_at >= $1 AND f.created_at < $2`, [r.from, r.to])).rows[0].v);
    return rent + fees;
  };
  const cash = async (r: ResolvedRange) => {
    const x = (await ctx.db.query(`SELECT kind, sum(amount) v FROM payment WHERE voided_at IS NULL AND paid_at >= $1 AND paid_at < $2 GROUP BY kind`, [r.from, r.to])).rows;
    const g = (k: string) => n(x.find((y: Row) => y.kind === k)?.v);
    return g('RENT') + g('FEE') + g('DEPOSIT') - g('REFUND');
  };
  const active = n((await ctx.db.query(`SELECT count(*)::int v FROM booking WHERE deleted_at IS NULL AND status='ACTIVE'`)).rows[0].v);
  const overdue = (await ctx.db.query(
    `SELECT b.id, b.code, c.name, c.phone, b.ends_at FROM booking b JOIN customer c ON c.id=b.customer_id WHERE b.deleted_at IS NULL AND b.status='ACTIVE' AND b.ends_at < $1 ORDER BY b.ends_at LIMIT 100`, [now])).rows;
  const cards: ReportCard[] = [];
  if (money) {
    cards.push({ label: 'Doanh thu hôm nay', value: await revenue(dayR), type: 'money', hint: 'ghi nhận theo ngày giao + phí phát sinh', href: '/reports/revenue' });
    cards.push({ label: 'Doanh thu tháng này', value: await revenue(monthStart), type: 'money', href: '/reports/revenue' });
    cards.push({ label: 'Thực thu hôm nay', value: await cash(dayR), type: 'money', hint: 'tiền thuê + phí + cọc − hoàn' });
  }
  cards.push({ label: 'Đơn đang thuê', value: active, type: 'int', href: '/bookings' });
  cards.push({ label: 'Đơn quá hạn', value: overdue.length, type: 'int', tone: overdue.length ? 'warn' : 'good', href: '/reports/debts' });
  if (money) {
    const dep = (await ctx.db.query(
      `SELECT coalesce(sum(greatest(0, d.dep - d.ref)),0) held FROM (SELECT b.id,
         coalesce((SELECT sum(amount) FROM payment p WHERE p.booking_id=b.id AND p.voided_at IS NULL AND p.kind='DEPOSIT'),0) dep,
         coalesce((SELECT sum(amount) FROM payment p WHERE p.booking_id=b.id AND p.voided_at IS NULL AND p.kind='REFUND'),0) ref
         FROM booking b WHERE b.deleted_at IS NULL AND b.status <> 'CLOSED') d`)).rows[0];
    cards.push({ label: 'Tiền cọc đang giữ', value: n(dep.held), type: 'money', href: '/reports/deposits' });
  }

  const status = (await ctx.db.query(`SELECT status, count(*)::int v FROM equipment_unit WHERE deleted_at IS NULL GROUP BY status`)).rows;
  const sections: ReportSection[] = [
    { title: 'Thiết bị theo trạng thái', columns: [col('status', 'Trạng thái'), col('n', 'Số chiếc', 'int')],
      rows: UNIT_STATUSES.map((s) => ({ status: UNIT_STATUS_LABEL[s], n: n(status.find((x: Row) => x.status === s)?.v) })), totals: { status: 'Tổng', n: sum(status, 'v') } },
  ];
  const todayBookings = async (sql: string, args: unknown[]) => (await ctx.db.query(sql, args)).rows;
  const deliver = await todayBookings(
    `SELECT b.code, c.name, c.phone, b.starts_at FROM booking b JOIN customer c ON c.id=b.customer_id WHERE b.deleted_at IS NULL AND b.status='CONFIRMED' AND b.starts_at >= $1 AND b.starts_at < $2 ORDER BY b.starts_at`, [dayR.from, dayR.to]);
  const receive = await todayBookings(
    `SELECT b.code, c.name, c.phone, b.ends_at FROM booking b JOIN customer c ON c.id=b.customer_id WHERE b.deleted_at IS NULL AND b.status='ACTIVE' AND b.ends_at < $1 ORDER BY b.ends_at`, [dayR.to]);
  const holds = await todayBookings(
    `SELECT b.code, c.name, c.phone, b.hold_expires_at FROM booking b JOIN customer c ON c.id=b.customer_id WHERE b.deleted_at IS NULL AND b.status='HOLD' AND b.hold_expires_at > $1 AND b.hold_expires_at <= $2 ORDER BY b.hold_expires_at`, [now, new Date(now.getTime() + DAY)]);
  const cols = (k: string, label: string) => [col('code', 'Đơn'), col('name', 'Khách'), col('phone', 'Điện thoại'), col(k, label, 'date')];
  const withDates = (rows: Row[], k: string): ReportRow[] => rows.map((r) => ({ code: r.code, name: r.name, phone: r.phone, [k]: dt(ctx, r[k]) }));
  sections.push({ title: 'Việc hôm nay: cần giao thiết bị', columns: cols('starts_at', 'Giờ nhận'), rows: withDates(deliver, 'starts_at') });
  sections.push({ title: 'Việc hôm nay: cần nhận thiết bị về (kể cả đã quá hạn)', columns: cols('ends_at', 'Hạn trả'), rows: withDates(receive, 'ends_at') });
  sections.push({ title: 'Giữ chỗ sắp hết hạn (24 giờ tới)', columns: cols('hold_expires_at', 'Hết hạn lúc'), rows: withDates(holds, 'hold_expires_at') });
  if (ctx.features['maintenance'] && ctx.permissions.has('maintenance.view')) {
    const wo = (await ctx.db.query(
      `SELECT w.code, u.barcode, w.title, w.status, to_char(w.due_date,'DD/MM/YYYY') due FROM work_order w JOIN equipment_unit u ON u.id=w.unit_id
       WHERE w.status IN ('PENDING','IN_PROGRESS') AND (w.due_date IS NULL OR w.due_date <= $1::date) ORDER BY w.due_date NULLS LAST LIMIT 50`, [today])).rows;
    sections.push({ title: 'Phiếu bảo trì đến hạn', columns: [col('code', 'Phiếu'), col('barcode', 'Thiết bị'), col('title', 'Việc'), col('status', 'Trạng thái'), col('due', 'Hạn')],
      rows: wo.map((w: Row) => ({ code: w.code, barcode: w.barcode, title: w.title, status: ORDER_STATUS_LABEL[w.status as keyof typeof ORDER_STATUS_LABEL], due: w.due })) });
  }
  return { key: 'dashboard', title: 'Tổng quan hôm nay', period: snapshotPeriod(ctx, now), cards, sections };
}

// ===== 2. Doanh thu =====
const FEE_COLS = FEE_KINDS.map((k) => col(`fee_${k}`, FEE_KIND_LABEL[k], 'money'));

async function revenue(ctx: ServiceCtx, f: ReportFilter, now: Date): Promise<ReportResult> {
  const r = range(ctx, f, now, 'month');
  const tz = tzOf(ctx);
  const g: GroupBy = f.groupBy ?? 'day';
  const a4 = [r.from, r.to, f.branchId ?? null, f.categoryId ?? null];
  const args = [...a4, tz];
  const scopeB = bookingScope('b', '$3', '$4');
  const time = g === 'day' || g === 'month';
  const fmt = g === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
  const base = `b.deleted_at IS NULL AND b.status IN ${COUNTED} AND coalesce(b.delivered_at,b.starts_at) >= $1 AND coalesce(b.delivered_at,b.starts_at) < $2 ${scopeB}`;
  const feeBase = `f.voided_at IS NULL AND b.deleted_at IS NULL AND b.status <> 'CANCELLED' AND f.created_at >= $1 AND f.created_at < $2 ${scopeB}`;
  const discount = `coalesce((b.quote->'discount'->>'amount')::numeric,0)`;

  type Acc = { key: string; label: string; bookings: number; rent: number; discount: number; fees: Record<FeeKind, number> };
  const acc = new Map<string, Acc>();
  const get = (key: string, label: string) => {
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { key, label, bookings: 0, rent: 0, discount: 0, fees: { LATE: 0, DAMAGE: 0, LOSS: 0, OTHER: 0 } }));
    return a;
  };
  let note: string | undefined;

  if (time) {
    for (const k of bucketKeys(r, g)) get(k, bucketLabel(k));
    for (const x of (await ctx.db.query(`SELECT to_char(coalesce(b.delivered_at,b.starts_at) AT TIME ZONE $5, '${fmt}') k, count(*)::int c, sum(b.total) rent, sum(${discount}) disc FROM booking b WHERE ${base} GROUP BY 1`, args)).rows) {
      const a = get(x.k, bucketLabel(x.k)); a.bookings = x.c; a.rent = n(x.rent); a.discount = n(x.disc);
    }
    for (const x of (await ctx.db.query(`SELECT to_char(f.created_at AT TIME ZONE $5, '${fmt}') k, f.kind, sum(f.amount) v FROM booking_fee f JOIN booking b ON b.id=f.booking_id WHERE ${feeBase} GROUP BY 1,2`, args)).rows)
      get(x.k, bucketLabel(x.k)).fees[x.kind as FeeKind] += n(x.v);
  } else if (g === 'staff') {
    const staff = `coalesce(u.name, '(Không rõ)')`;
    for (const x of (await ctx.db.query(`SELECT ${staff} k, count(*)::int c, sum(b.total) rent, sum(${discount}) disc FROM booking b LEFT JOIN app_user u ON u.id=b.created_by WHERE ${base} GROUP BY 1`, a4)).rows) {
      const a = get(x.k, x.k); a.bookings = x.c; a.rent = n(x.rent); a.discount = n(x.disc);
    }
    for (const x of (await ctx.db.query(`SELECT ${staff} k, f.kind, sum(f.amount) v FROM booking_fee f JOIN booking b ON b.id=f.booking_id LEFT JOIN app_user u ON u.id=b.created_by WHERE ${feeBase} GROUP BY 1,2`, a4)).rows)
      get(x.k, x.k).fees[x.kind as FeeKind] += n(x.v);
  } else {
    // model / category / branch: tiền thuê tính theo dòng đơn (trước giảm giá, phí giao, VAT); chiếc nào thì chi nhánh đó
    const dim = g === 'model' ? `m.name` : g === 'category' ? `coalesce(cat.name, '(Chưa phân loại)')` : `coalesce(br.name, '(Không rõ chi nhánh)')`;
    const unitDim = g === 'model' ? `m.name` : g === 'category' ? `coalesce(cat.name, '(Chưa phân loại)')` : `coalesce(br.name, '(Không rõ chi nhánh)')`;
    const feeDim = `CASE WHEN f.unit_id IS NULL THEN '(Phí không gắn thiết bị)' ELSE ${unitDim} END`;
    const joinsLine = `FROM booking_line l JOIN booking b ON b.id=l.booking_id JOIN equipment_model m ON m.id=l.model_id LEFT JOIN category cat ON cat.id=m.category_id
      LEFT JOIN LATERAL (SELECT count(*) c FROM unit_allocation a WHERE a.booking_line_id=l.id) ac ON true
      LEFT JOIN unit_allocation a2 ON a2.booking_line_id=l.id LEFT JOIN equipment_unit un ON un.id=a2.unit_id LEFT JOIN branch br ON br.id=un.branch_id`;
    for (const x of (await ctx.db.query(`SELECT ${dim} k, count(DISTINCT l.booking_id)::int c, sum(l.line_total::numeric / greatest(1, ac.c)) rent ${joinsLine} WHERE ${base} GROUP BY 1`, a4)).rows) {
      const a = get(x.k, x.k); a.bookings = x.c; a.rent = Math.round(n(x.rent));
    }
    for (const x of (await ctx.db.query(
      `SELECT ${feeDim} k, f.kind, sum(f.amount) v FROM booking_fee f JOIN booking b ON b.id=f.booking_id LEFT JOIN equipment_unit un ON un.id=f.unit_id
       LEFT JOIN equipment_model m ON m.id=un.model_id LEFT JOIN category cat ON cat.id=m.category_id LEFT JOIN branch br ON br.id=un.branch_id WHERE ${feeBase} GROUP BY 1,2`, a4)).rows)
      get(x.k, x.k).fees[x.kind as FeeKind] += n(x.v);
    note = 'Tiền thuê theo nhóm này tính theo từng dòng thiết bị trong đơn, trước giảm giá, phí giao nhận và VAT nên tổng có thể khác tổng theo ngày.';
  }

  const list = [...acc.values()].filter((a) => !time || true).sort((a, b) => (time ? a.key.localeCompare(b.key) : (b.rent + sumFees(b)) - (a.rent + sumFees(a))));
  const rows: ReportRow[] = list.map((a) => ({
    g: a.label, bookings: a.bookings, rent: a.rent, ...Object.fromEntries(FEE_KINDS.map((k) => [`fee_${k}`, a.fees[k]])), total: a.rent + sumFees(a), discount: a.discount,
  }));
  const totals: ReportRow = { g: 'Tổng', bookings: sum(rows, 'bookings'), rent: sum(rows, 'rent'), ...Object.fromEntries(FEE_KINDS.map((k) => [`fee_${k}`, sum(rows, `fee_${k}`)])), total: sum(rows, 'total'), discount: sum(rows, 'discount') };
  const columns = [col('g', ((l) => l.charAt(0).toUpperCase() + l.slice(1))(GROUP_BY_LABEL[g].replace('Theo ', ''))), col('bookings', 'Số đơn', 'int'), col('rent', 'Tiền thuê', 'money'), ...FEE_COLS, col('total', 'Doanh thu ghi nhận', 'money'), col('discount', 'Giảm giá (đã trừ)', 'money')];
  const accrual: ReportSection = {
    title: 'Doanh thu ghi nhận', columns, rows, totals, note,
    chart: time ? { type: g === 'day' ? 'line' : 'bar', labelKey: 'g', series: [{ key: 'total', label: 'Doanh thu ghi nhận' }] } : { type: 'bar', labelKey: 'g', series: [{ key: 'total', label: 'Doanh thu ghi nhận' }] },
  };

  // Thực thu: dòng tiền theo loại khoản, cùng mốc thời gian
  const cashFmt = g === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
  const cashRows = (await ctx.db.query(
    `SELECT ${time ? `to_char(p.paid_at AT TIME ZONE $5, '${cashFmt}')` : `'Cả kỳ'`} k, p.kind, sum(p.amount) v FROM payment p JOIN booking b ON b.id=p.booking_id
     WHERE p.voided_at IS NULL AND p.paid_at >= $1 AND p.paid_at < $2 AND b.deleted_at IS NULL ${scopeB} GROUP BY 1,2`, time ? args : a4)).rows;
  const cmap = new Map<string, Record<string, number>>();
  if (time) for (const k of bucketKeys(r, g)) cmap.set(k, {});
  for (const x of cashRows) { const m = cmap.get(x.k) ?? {}; m[x.kind] = n(x.v); cmap.set(x.k, m); }
  if (!time && cmap.size === 0) cmap.set('Cả kỳ', {});
  const netOf = (m: Record<string, number>) => (m.RENT ?? 0) + (m.FEE ?? 0) + (m.DEPOSIT ?? 0) - (m.REFUND ?? 0);
  const crow = [...cmap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, m]): ReportRow => ({
    g: time ? bucketLabel(k) : k, ...Object.fromEntries(PAYMENT_KINDS.map((p) => [p, m[p] ?? 0])), net: netOf(m),
  }));
  const cash: ReportSection = {
    title: 'Thực thu (dòng tiền)', columns: [col('g', time ? 'Mốc' : 'Kỳ'), ...PAYMENT_KINDS.map((p) => col(p, PAYMENT_KIND_LABEL[p], 'money')), col('net', 'Tiền ròng thu về', 'money')],
    rows: crow, totals: { g: 'Tổng', ...Object.fromEntries(PAYMENT_KINDS.map((p) => [p, sum(crow, p)])), net: sum(crow, 'net') },
    note: 'Tiền ròng = tiền thuê + phí + cọc − hoàn. "Xóa nợ" không phải tiền thu thật nên không cộng vào. Tiền cọc được khấu trừ vào khoản phải thu không xuất hiện ở đây dưới dạng thu tiền thuê.',
    chart: time ? { type: 'bar', labelKey: 'g', series: [{ key: 'net', label: 'Tiền ròng thu về' }] } : undefined,
  };
  return {
    key: 'revenue', title: 'Doanh thu', period: describePeriod(r),
    cards: [
      { label: 'Doanh thu ghi nhận', value: n(totals.total), type: 'money', hint: 'tiền thuê của đơn đã giao + phí phát sinh' },
      { label: 'Tiền ròng thu về', value: n(cash.totals!.net), type: 'money', hint: 'dòng tiền thực tế' },
      { label: 'Số đơn', value: n(totals.bookings), type: 'int' },
      { label: 'Giảm giá đã cho', value: n(totals.discount), type: 'money' },
    ],
    sections: [accrual, cash],
    notes: ['Ghi nhận theo ngày giao thiết bị (đơn chưa giao hoặc đã hủy không tính). Phí phát sinh tính theo ngày phát sinh phí; khoản phí đã hủy không tính.', 'Bộ lọc chi nhánh/danh mục giữ lại các đơn có ít nhất một dòng thiết bị thuộc chi nhánh/danh mục đó (tính cả đơn).'],
  };
}
const sumFees = (a: { fees: Record<FeeKind, number> }) => FEE_KINDS.reduce((s, k) => s + a.fees[k], 0);

// ===== 3. Quá hạn & công nợ =====
async function debts(ctx: ServiceCtx, f: ReportFilter, now: Date): Promise<ReportResult> {
  const scope = bookingScope('b', '$2', '$3');
  const args = [now, f.branchId ?? null, f.categoryId ?? null];
  const scope2 = bookingScope('b', '$1', '$2');
  const args2 = [f.branchId ?? null, f.categoryId ?? null];
  const over = (await ctx.db.query(
    `SELECT b.id, b.code, c.name, c.phone, b.ends_at FROM booking b JOIN customer c ON c.id=b.customer_id WHERE b.deleted_at IS NULL AND b.status='ACTIVE' AND b.ends_at < $1 ${scope} ORDER BY b.ends_at LIMIT 500`, args)).rows;
  const candidates = (await ctx.db.query(
    `SELECT b.id, b.code, c.name, c.phone, b.returned_at FROM booking b JOIN customer c ON c.id=b.customer_id WHERE b.deleted_at IS NULL AND b.status='RETURNED' ${scope2} ORDER BY b.returned_at LIMIT 1000`, args2)).rows;
  const debtRows: (Row & { owed: number; days: number })[] = [];
  for (const b of candidates) {
    const owed = (await computeLedger(ctx, b.id)).settlement.balanceOwed;
    if (owed > 0) debtRows.push({ ...b, owed, days: Math.max(0, (now.getTime() - (b.returned_at ?? now).getTime()) / DAY) });
  }
  const buckets = AGING_BUCKETS.map((label) => {
    const rs = debtRows.filter((d) => agingBucket(d.days) === label);
    return { label, count: rs.length, owed: rs.reduce((a, d) => a + d.owed, 0) };
  });
  const total = debtRows.reduce((a, d) => a + d.owed, 0);
  return {
    key: 'debts', title: 'Quá hạn và công nợ', period: snapshotPeriod(ctx, now),
    cards: [
      { label: 'Đơn quá hạn chưa trả', value: over.length, type: 'int', tone: over.length ? 'warn' : 'good' },
      { label: 'Tổng công nợ', value: total, type: 'money', tone: total ? 'warn' : 'good', hint: 'đơn đã nhận lại thiết bị nhưng khách còn nợ' },
      { label: 'Số đơn còn nợ', value: debtRows.length, type: 'int' },
    ],
    sections: [
      { title: 'Tuổi nợ', columns: [col('b', 'Nhóm tuổi nợ (từ lúc nhận lại)'), col('count', 'Số đơn', 'int'), col('owed', 'Số tiền nợ', 'money')],
        rows: buckets.map((b) => ({ b: b.label, count: b.count, owed: b.owed })), totals: { b: 'Tổng', count: debtRows.length, owed: total }, chart: { type: 'bar', labelKey: 'b', series: [{ key: 'owed', label: 'Số tiền nợ' }] } },
      { title: 'Chi tiết công nợ', columns: [col('code', 'Đơn'), col('name', 'Khách'), col('phone', 'Điện thoại'), col('returned', 'Nhận lại lúc', 'date'), col('days', 'Số ngày nợ', 'int'), col('owed', 'Còn nợ', 'money'), col('bucket', 'Nhóm tuổi nợ')],
        rows: debtRows.sort((a, b) => b.owed - a.owed).map((d) => ({ code: d.code, name: d.name, phone: d.phone, returned: dt(ctx, d.returned_at), days: Math.floor(d.days), owed: d.owed, bucket: agingBucket(d.days) })) },
      { title: 'Đơn quá hạn chưa trả', columns: [col('code', 'Đơn'), col('name', 'Khách'), col('phone', 'Điện thoại'), col('ends', 'Hạn trả', 'date'), col('hours', 'Quá hạn (giờ)', 'hours')],
        rows: over.map((o: Row) => ({ code: o.code, name: o.name, phone: o.phone, ends: dt(ctx, o.ends_at), hours: Math.round(((now.getTime() - o.ends_at.getTime()) / HOUR) * 10) / 10 })) },
    ],
  };
}

// ===== 4. Tiền cọc và tài sản cọc =====
async function deposits(ctx: ServiceCtx, _f: ReportFilter, now: Date): Promise<ReportResult> {
  const rows = (await ctx.db.query(
    `SELECT * FROM (SELECT b.id, b.code, b.status, c.name,
       coalesce((SELECT sum(amount) FROM payment p WHERE p.booking_id=b.id AND p.voided_at IS NULL AND p.kind='DEPOSIT'),0) dep,
       coalesce((SELECT sum(amount) FROM payment p WHERE p.booking_id=b.id AND p.voided_at IS NULL AND p.kind='REFUND'),0) ref,
       (SELECT min(paid_at) FROM payment p WHERE p.booking_id=b.id AND p.voided_at IS NULL AND p.kind='DEPOSIT') since,
       coalesce((SELECT sum(estimated_value) FROM deposit_asset a WHERE a.booking_id=b.id AND a.status='HELD'),0) assets_value,
       (SELECT string_agg(a.description, '; ') FROM deposit_asset a WHERE a.booking_id=b.id AND a.status='HELD') assets
     FROM booking b JOIN customer c ON c.id=b.customer_id WHERE b.deleted_at IS NULL AND b.status <> 'CLOSED') x
     WHERE greatest(0, dep - ref) > 0 OR assets_value > 0 OR assets IS NOT NULL ORDER BY since NULLS LAST`)).rows;
  const view: Row[] = rows.map((r: Row) => ({ ...r, held: Math.max(0, n(r.dep) - n(r.ref)), age: r.since ? Math.floor((now.getTime() - r.since.getTime()) / DAY) : null }));
  const money = sum(view, 'held');
  const assets = sum(view, 'assets_value');
  const stale = view.filter((v) => ['RETURNED', 'CANCELLED'].includes(v.status));
  const STATUS: Record<string, string> = { QUOTE: 'Báo giá', HOLD: 'Giữ chỗ', CONFIRMED: 'Đã xác nhận', ACTIVE: 'Đang thuê', RETURNED: 'Đã nhận lại', CANCELLED: 'Đã hủy' };
  return {
    key: 'deposits', title: 'Tiền cọc và tài sản thế chấp', period: snapshotPeriod(ctx, now),
    cards: [
      { label: 'Tiền cọc đang giữ', value: money, type: 'money' },
      { label: 'Giá trị tài sản thế chấp', value: assets, type: 'money', hint: 'theo giá ước tính khi nhận' },
      { label: 'Đơn cần quyết toán cọc', value: stale.length, type: 'int', tone: stale.length ? 'warn' : 'good', hint: 'đã nhận lại / đã hủy mà vẫn giữ cọc hoặc tài sản' },
    ],
    sections: [{
      title: 'Chi tiết theo đơn', columns: [col('code', 'Đơn'), col('name', 'Khách'), col('status', 'Trạng thái'), col('held', 'Tiền cọc giữ', 'money'), col('assets', 'Tài sản thế chấp'), col('av', 'Giá trị tài sản', 'money'), col('age', 'Giữ được (ngày)', 'int'), col('flag', 'Cần xử lý')],
      rows: view.map((v) => ({ code: v.code, name: v.name, status: STATUS[v.status] ?? v.status, held: v.held, assets: v.assets, av: n(v.assets_value), age: v.age, flag: ['RETURNED', 'CANCELLED'].includes(v.status) ? 'Quyết toán / hoàn cọc' : '' })),
      totals: { code: 'Tổng', held: money, av: assets },
    }],
  };
}

// ===== 5. Hiệu suất sử dụng =====
async function utilizationReport(ctx: ServiceCtx, f: ReportFilter, now: Date): Promise<ReportResult> {
  const r = range(ctx, f, now, 'month');
  const rows = (await ctx.db.query(
    `SELECT u.id, u.barcode, u.created_at, m.id AS model_id, m.name AS model_name, br.name AS branch,
       greatest(0, extract(epoch FROM ($2::timestamptz - greatest($1::timestamptz, u.created_at))) / 3600)::float8 AS cap,
       coalesce(bz.hours, 0)::float8 AS busy, coalesce(bz.rentals, 0)::int AS rentals
     FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id LEFT JOIN branch br ON br.id=u.branch_id
     LEFT JOIN (
       SELECT a.unit_id, sum(extract(epoch FROM (upper(x) - lower(x))) / 3600) AS hours, count(DISTINCT a.booking_id) AS rentals
       FROM unit_allocation a JOIN booking b ON b.id=a.booking_id AND b.status IN ${COUNTED} AND b.deleted_at IS NULL
       JOIN equipment_unit uu ON uu.id=a.unit_id JOIN equipment_model mm ON mm.id=uu.model_id,
       LATERAL (SELECT tstzrange(lower(a.period), greatest(lower(a.period), upper(a.period) - mm.buffer_minutes * interval '1 minute'), '[)') * tstzrange(least(greatest($1::timestamptz, uu.created_at), $2::timestamptz), $2::timestamptz, '[)') AS x) t
       WHERE NOT isempty(x) GROUP BY a.unit_id
     ) bz ON bz.unit_id = u.id
     WHERE u.deleted_at IS NULL AND u.status NOT IN ('RETIRED','LOST') AND m.tracked AND ($3::uuid IS NULL OR u.branch_id=$3) AND ($4::uuid IS NULL OR m.category_id=$4)
     ORDER BY m.name, u.barcode`, [r.from, r.to, f.branchId ?? null, f.categoryId ?? null])).rows;
  const byModel = new Map<string, { name: string; units: number; cap: number; busy: number; rentals: number }>();
  for (const u of rows) {
    const m = byModel.get(u.model_id) ?? { name: u.model_name, units: 0, cap: 0, busy: 0, rentals: 0 };
    m.units++; m.cap += u.cap; m.busy += u.busy; m.rentals += u.rentals;
    byModel.set(u.model_id, m);
  }
  const models = [...byModel.entries()].map(([id, m]) => ({ id, ...m, util: utilization(m.busy, m.cap) })).sort((a, b) => b.util - a.util);
  const modelUtil = new Map(models.map((m) => [m.id, m.util]));
  const units: Row[] = rows.map((u: Row) => {
    const util = utilization(u.busy, u.cap);
    return { ...u, util, hint: utilizationHint({ modelUtilization: modelUtil.get(u.model_id) ?? 0, unitUtilization: util, unitAgeDays: (now.getTime() - u.created_at.getTime()) / DAY }) };
  }).sort((a: Row, b: Row) => a.util - b.util);
  const totalCap = sum(rows, 'cap'), totalBusy = sum(rows, 'busy');
  return {
    key: 'utilization', title: 'Hiệu suất sử dụng thiết bị', period: describePeriod(r),
    cards: [
      { label: 'Mức sử dụng chung', value: utilization(totalBusy, totalCap), type: 'percent', hint: 'giờ được thuê / giờ có thể thuê' },
      { label: 'Số thiết bị', value: rows.length, type: 'int' },
      { label: 'Gợi ý thanh lý', value: units.filter((u) => u.hint?.includes('thanh lý')).length, type: 'int', hint: `dưới ${LOW_UTILIZATION * 100}% và đã dùng từ 90 ngày` },
      { label: 'Mẫu thường hết hàng', value: models.filter((m) => m.util >= HIGH_UTILIZATION).length, type: 'int', hint: `từ ${HIGH_UTILIZATION * 100}% trở lên` },
    ],
    sections: [
      { title: 'Theo mẫu thiết bị', columns: [col('name', 'Mẫu'), col('units', 'Số chiếc', 'int'), col('busy', 'Giờ được thuê', 'hours'), col('cap', 'Giờ có thể thuê', 'hours'), col('util', 'Mức sử dụng', 'percent'), col('rentals', 'Lượt thuê', 'int'), col('hint', 'Gợi ý')],
        rows: models.map((m) => ({ name: m.name, units: m.units, busy: round1(m.busy), cap: round1(m.cap), util: m.util, rentals: m.rentals, hint: m.util >= HIGH_UTILIZATION ? 'Thường hết hàng: cân nhắc mua thêm' : '' })),
        chart: { type: 'bar', labelKey: 'name', series: [{ key: 'util', label: 'Mức sử dụng' }] } },
      { title: 'Từng thiết bị (ít được thuê nhất lên đầu)', columns: [col('barcode', 'Mã'), col('model', 'Mẫu'), col('branch', 'Chi nhánh'), col('busy', 'Giờ được thuê', 'hours'), col('util', 'Mức sử dụng', 'percent'), col('rentals', 'Lượt thuê', 'int'), col('hint', 'Gợi ý')],
        rows: units.slice(0, 100).map((u) => ({ barcode: u.barcode, model: u.model_name, branch: u.branch, busy: round1(u.busy), util: u.util, rentals: u.rentals, hint: u.hint ?? '' })) },
    ],
    notes: ['Giờ được thuê tính trên các đơn đã giao (kể cả đang thuê), không gồm thời gian đệm sau mỗi đơn. Thiết bị mới thêm chỉ tính từ ngày tạo.', 'Gợi ý chỉ mang tính tham khảo từ quy tắc đơn giản (mức sử dụng), chưa xét mùa vụ.'],
  };
}
const round1 = (x: number) => Math.round(x * 10) / 10;

// ===== 6. Hoàn vốn (ROI) =====
async function roiReport(ctx: ServiceCtx, f: ReportFilter, now: Date): Promise<ReportResult> {
  const r = range(ctx, f, now, 'all');
  const rows = (await ctx.db.query(
    `SELECT u.id, u.barcode, u.purchase_price, m.name AS model_name,
       coalesce((SELECT sum(l.line_total::numeric / greatest(1, (SELECT count(*) FROM unit_allocation a2 WHERE a2.booking_line_id=l.id)))
                 FROM unit_allocation a JOIN booking_line l ON l.id=a.booking_line_id JOIN booking b ON b.id=l.booking_id
                 WHERE a.unit_id=u.id AND b.deleted_at IS NULL AND b.status IN ${COUNTED} AND coalesce(b.delivered_at,b.starts_at) >= $1 AND coalesce(b.delivered_at,b.starts_at) < $2), 0)::float8 AS rent,
       coalesce((SELECT sum(fe.amount) FROM booking_fee fe JOIN booking b ON b.id=fe.booking_id WHERE fe.unit_id=u.id AND fe.voided_at IS NULL AND b.status <> 'CANCELLED' AND fe.created_at >= $1 AND fe.created_at < $2), 0)::float8 AS fees,
       coalesce((SELECT sum(w.cost_total) FROM work_order w WHERE w.unit_id=u.id AND w.status <> 'CANCELLED' AND w.created_at >= $1 AND w.created_at < $2), 0)::float8 AS cost
     FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id
     WHERE u.deleted_at IS NULL AND m.tracked AND ($3::uuid IS NULL OR u.branch_id=$3) AND ($4::uuid IS NULL OR m.category_id=$4) ORDER BY m.name, u.barcode`,
    [r.from, r.to, f.branchId ?? null, f.categoryId ?? null])).rows;
  const view = rows.map((u: Row) => {
    const rev = Math.round(n(u.rent)) + n(u.fees);
    const x = roi({ revenue: rev, cost: n(u.cost), purchasePrice: u.purchase_price === null ? null : n(u.purchase_price) });
    return { u, rev, cost: n(u.cost), x };
  }).sort((a, b) => b.x.net - a.x.net);
  const price = (v: (typeof view)[number]) => (v.u.purchase_price === null ? null : n(v.u.purchase_price));
  const tot = { rev: view.reduce((a, v) => a + v.rev, 0), cost: view.reduce((a, v) => a + v.cost, 0), price: view.reduce((a, v) => a + (price(v) ?? 0), 0) };
  const backed = view.filter((v) => v.x.paidBack).length;
  return {
    key: 'roi', title: 'Hoàn vốn (ROI) từng thiết bị', period: describePeriod(r),
    cards: [
      { label: 'Doanh thu từ thiết bị', value: tot.rev, type: 'money' },
      { label: 'Chi phí bảo trì', value: tot.cost, type: 'money' },
      { label: 'Tổng giá nhập', value: tot.price, type: 'money' },
      { label: 'Đã hoàn vốn', value: backed, type: 'int', hint: `trên ${view.filter((v) => price(v) !== null).length} thiết bị có giá nhập` },
    ],
    sections: [{
      title: 'Theo thiết bị', columns: [col('barcode', 'Mã'), col('model', 'Mẫu'), col('price', 'Giá nhập', 'money'), col('rev', 'Doanh thu', 'money'), col('cost', 'Chi phí bảo trì', 'money'), col('net', 'Lãi gộp', 'money'), col('roi', 'Hoàn vốn', 'percent'), col('state', 'Tình trạng')],
      rows: view.map((v) => ({ barcode: v.u.barcode, model: v.u.model_name, price: price(v), rev: v.rev, cost: v.cost, net: v.x.net, roi: v.x.roi, state: v.x.paidBack === null ? 'Chưa có giá nhập' : v.x.paidBack ? 'Đã hoàn vốn' : `Còn thiếu ${new Intl.NumberFormat('vi-VN').format(v.x.remaining ?? 0)} đ` })),
      totals: { barcode: 'Tổng', price: tot.price, rev: tot.rev, cost: tot.cost, net: tot.rev - tot.cost, roi: tot.price > 0 ? ratio(tot.rev - tot.cost, tot.price) : null },
    }],
    notes: ['Doanh thu = tiền thuê của các đơn đã giao chia đều cho các chiếc trong dòng đơn + phí hư hỏng/mất gắn với chiếc đó. Chưa trừ giảm giá, VAT, phí giao nhận của cả đơn.', 'Chi phí = tổng chi phí các phiếu bảo trì/sửa chữa (trừ phiếu đã hủy). Hoàn vốn = (doanh thu − chi phí) / giá nhập.'],
  };
}

// ===== 7. Bảo trì =====
async function maintenanceReport(ctx: ServiceCtx, f: ReportFilter, now: Date): Promise<ReportResult> {
  const r = range(ctx, f, now, 'month');
  const a5 = [r.from, r.to, f.branchId ?? null, f.categoryId ?? null, now];
  const scope = `AND ($3::uuid IS NULL OR u.branch_id=$3) AND ($4::uuid IS NULL OR m.category_id=$4)`;
  const byModel = (await ctx.db.query(
    `SELECT m.name, count(*)::int orders, count(*) FILTER (WHERE w.kind='REPAIR')::int repairs, count(*) FILTER (WHERE w.status='UNREPAIRABLE' OR w.status='DISPOSED')::int dead,
       coalesce(sum(w.cost_total),0) cost,
       coalesce(sum(extract(epoch FROM (coalesce(w.finished_at, $5::timestamptz) - w.started_at)) / 3600) FILTER (WHERE w.started_at IS NOT NULL),0)::float8 downtime
     FROM work_order w JOIN equipment_unit u ON u.id=w.unit_id JOIN equipment_model m ON m.id=u.model_id
     WHERE w.status <> 'CANCELLED' AND w.created_at >= $1 AND w.created_at < $2 ${scope} GROUP BY m.name ORDER BY cost DESC`, a5)).rows;
  const monthly = (await ctx.db.query(
    `SELECT to_char(w.created_at AT TIME ZONE $5, 'YYYY-MM') k, count(*)::int orders, coalesce(sum(w.cost_total),0) cost
     FROM work_order w JOIN equipment_unit u ON u.id=w.unit_id JOIN equipment_model m ON m.id=u.model_id WHERE w.status <> 'CANCELLED' AND w.created_at >= $1 AND w.created_at < $2 ${scope} GROUP BY 1`, [r.from, r.to, f.branchId ?? null, f.categoryId ?? null, tzOf(ctx)])).rows;
  const overdue = (await ctx.db.query(
    `SELECT w.code, u.barcode, w.title, w.status, to_char(w.due_date,'DD/MM/YYYY') due, (($3::timestamptz AT TIME ZONE $4)::date - w.due_date) AS late
     FROM work_order w JOIN equipment_unit u ON u.id=w.unit_id JOIN equipment_model m ON m.id=u.model_id
     WHERE w.status IN ('PENDING','IN_PROGRESS') AND w.due_date < ($3::timestamptz AT TIME ZONE $4)::date AND ($1::uuid IS NULL OR u.branch_id=$1) AND ($2::uuid IS NULL OR m.category_id=$2) ORDER BY w.due_date`, [f.branchId ?? null, f.categoryId ?? null, now, tzOf(ctx)])).rows;
  const keys = bucketKeys(r, 'month');
  const mrows: ReportRow[] = keys.map((k) => ({ g: bucketLabel(k), orders: n(monthly.find((x: Row) => x.k === k)?.orders), cost: n(monthly.find((x: Row) => x.k === k)?.cost) }));
  const tot = { orders: sum(byModel, 'orders'), repairs: sum(byModel, 'repairs'), cost: sum(byModel, 'cost'), down: sum(byModel, 'downtime') };
  return {
    key: 'maintenance', title: 'Báo cáo bảo trì', period: describePeriod(r),
    cards: [
      { label: 'Chi phí bảo trì', value: tot.cost, type: 'money' },
      { label: 'Số phiếu', value: tot.orders, type: 'int' },
      { label: 'Số lần hỏng cần sửa', value: tot.repairs, type: 'int' },
      { label: 'Thời gian chết', value: round1(tot.down), type: 'hours', hint: 'tổng giờ thiết bị nằm trong bảo trì' },
      { label: 'Phiếu quá hạn', value: overdue.length, type: 'int', tone: overdue.length ? 'warn' : 'good' },
    ],
    sections: [
      { title: 'Theo mẫu thiết bị', columns: [col('name', 'Mẫu'), col('orders', 'Số phiếu', 'int'), col('repairs', 'Lần sửa chữa', 'int'), col('dead', 'Không sửa được / thanh lý', 'int'), col('cost', 'Chi phí', 'money'), col('downtime', 'Thời gian chết (giờ)', 'hours')],
        rows: byModel.map((m: Row) => ({ name: m.name, orders: m.orders, repairs: m.repairs, dead: m.dead, cost: n(m.cost), downtime: round1(m.downtime) })),
        totals: { name: 'Tổng', orders: tot.orders, repairs: tot.repairs, dead: sum(byModel, 'dead'), cost: tot.cost, downtime: round1(tot.down) } },
      { title: 'Chi phí theo tháng', columns: [col('g', 'Tháng'), col('orders', 'Số phiếu', 'int'), col('cost', 'Chi phí', 'money')], rows: mrows, chart: { type: 'bar', labelKey: 'g', series: [{ key: 'cost', label: 'Chi phí' }] } },
      { title: 'Phiếu quá hạn', columns: [col('code', 'Phiếu'), col('barcode', 'Thiết bị'), col('title', 'Việc'), col('status', 'Trạng thái'), col('due', 'Hạn'), col('late', 'Trễ (ngày)', 'int')],
        rows: overdue.map((o: Row) => ({ code: o.code, barcode: o.barcode, title: o.title, status: ORDER_STATUS_LABEL[o.status as keyof typeof ORDER_STATUS_LABEL], due: o.due, late: n(o.late) })) },
    ],
    notes: ['Phiếu tính theo ngày tạo. Thời gian chết là từ lúc bắt đầu làm đến lúc hoàn thành (phiếu đang làm tính đến hiện tại).'],
  };
}

// ===== 8. Khách hàng =====
async function customersReport(ctx: ServiceCtx, f: ReportFilter, now: Date): Promise<ReportResult> {
  const r = range(ctx, f, now, 'all');
  const rows = (await ctx.db.query(
    `SELECT c.id, c.name, c.phone, count(*)::int rentals, sum(b.total) revenue,
       count(*) FILTER (WHERE (b.returned_at IS NOT NULL AND b.returned_at > b.ends_at) OR (b.returned_at IS NULL AND b.status='ACTIVE' AND $3::timestamptz > b.ends_at))::int late,
       coalesce(avg(extract(epoch FROM (coalesce(b.returned_at, $3::timestamptz) - b.ends_at)) / 3600) FILTER (WHERE (b.returned_at IS NOT NULL AND b.returned_at > b.ends_at) OR (b.returned_at IS NULL AND b.status='ACTIVE' AND $3::timestamptz > b.ends_at)),0)::float8 late_hours
     FROM booking b JOIN customer c ON c.id=b.customer_id
     WHERE b.deleted_at IS NULL AND b.status IN ${COUNTED} AND coalesce(b.delivered_at,b.starts_at) >= $1 AND coalesce(b.delivered_at,b.starts_at) < $2 ${bookingScope('b', '$4', '$5')}
     GROUP BY c.id, c.name, c.phone`, [r.from, r.to, now, f.branchId ?? null, f.categoryId ?? null])).rows;
  const newCount = n((await ctx.db.query('SELECT count(*)::int v FROM customer WHERE deleted_at IS NULL AND created_at >= $1 AND created_at < $2', [r.from, r.to])).rows[0].v);
  const top = [...rows].sort((a, b) => n(b.revenue) - n(a.revenue)).slice(0, 20);
  const risky = rows.filter((c: Row) => c.late >= 2 && c.late / c.rentals >= 0.5).sort((a: Row, b: Row) => b.late - a.late).slice(0, 20);
  const lateTotal = sum(rows, 'late'), rentTotal = sum(rows, 'rentals');
  return {
    key: 'customers', title: 'Báo cáo khách hàng', period: describePeriod(r),
    cards: [
      { label: 'Khách có phát sinh thuê', value: rows.length, type: 'int' },
      { label: 'Khách mới', value: newCount, type: 'int', hint: 'tạo trong kỳ' },
      { label: 'Tỷ lệ đơn trả trễ', value: ratio(lateTotal, rentTotal), type: 'percent' },
    ],
    sections: [
      { title: 'Khách thuê nhiều nhất (theo doanh thu)', columns: [col('name', 'Khách'), col('phone', 'Điện thoại'), col('rentals', 'Số đơn', 'int'), col('revenue', 'Tiền thuê', 'money'), col('late', 'Đơn trả trễ', 'int'), col('rate', 'Tỷ lệ trễ', 'percent')],
        rows: top.map((c: Row) => ({ name: c.name, phone: c.phone, rentals: c.rentals, revenue: n(c.revenue), late: c.late, rate: ratio(c.late, c.rentals) })) },
      { title: 'Khách hay trả trễ (từ 2 đơn trễ, trễ từ một nửa số đơn)', columns: [col('name', 'Khách'), col('phone', 'Điện thoại'), col('rentals', 'Số đơn', 'int'), col('late', 'Đơn trả trễ', 'int'), col('rate', 'Tỷ lệ trễ', 'percent'), col('hours', 'Trễ trung bình (giờ)', 'hours')],
        rows: risky.map((c: Row) => ({ name: c.name, phone: c.phone, rentals: c.rentals, late: c.late, rate: ratio(c.late, c.rentals), hours: round1(c.late_hours) })) },
    ],
    notes: ['Đơn trễ = nhận lại sau hạn trả, hoặc đang thuê mà đã quá hạn. Tiền thuê là tổng tiền đơn (chưa gồm phí phát sinh).'],
  };
}

// ===== 9. Tồn kho / kiểm kê =====
async function inventoryReport(ctx: ServiceCtx, f: ReportFilter, now: Date): Promise<ReportResult> {
  const scope = `AND ($1::uuid IS NULL OR u.branch_id=$1) AND ($2::uuid IS NULL OR m.category_id=$2)`;
  const args = [f.branchId ?? null, f.categoryId ?? null];
  const cat = (await ctx.db.query(
    `SELECT coalesce(c.name, '(Chưa phân loại)') cat, u.status, count(*)::int v FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id LEFT JOIN category c ON c.id=m.category_id
     WHERE u.deleted_at IS NULL ${scope} GROUP BY 1,2`, args)).rows;
  const cats = [...new Set(cat.map((x: Row) => x.cat as string))].sort();
  const sRows: ReportRow[] = cats.map((c) => {
    const row: ReportRow = { cat: c, total: 0 };
    for (const s of UNIT_STATUSES) { const v = n(cat.find((x: Row) => x.cat === c && x.status === s)?.v); row[s] = v; (row.total as number) += v; }
    return row;
  });
  const sTot: ReportRow = { cat: 'Tổng', total: sum(sRows as Row[], 'total'), ...Object.fromEntries(UNIT_STATUSES.map((s) => [s, sum(sRows as Row[], s)])) };
  const cond = (await ctx.db.query(`SELECT u.condition, count(*)::int v FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id WHERE u.deleted_at IS NULL AND u.status NOT IN ('RETIRED','LOST') ${scope} GROUP BY 1`, args)).rows;
  const qty = (await ctx.db.query(
    `SELECT m.name, m.stock_qty, coalesce((SELECT sum(q.qty) FROM qty_allocation q WHERE q.model_id=m.id AND q.status IN ('HOLD','CONFIRMED','ACTIVE') AND q.period @> $2::timestamptz),0)::int used
     FROM equipment_model m WHERE m.deleted_at IS NULL AND NOT m.tracked AND ($1::uuid IS NULL OR m.category_id=$1) ORDER BY m.name`, [f.categoryId ?? null, now])).rows;
  const sections: ReportSection[] = [
    { title: 'Thiết bị theo danh mục và trạng thái', columns: [col('cat', 'Danh mục'), ...UNIT_STATUSES.map((s) => col(s, UNIT_STATUS_LABEL[s], 'int')), col('total', 'Tổng', 'int')], rows: sRows, totals: sTot },
    { title: 'Tình trạng vật lý (thiết bị còn dùng)', columns: [col('c', 'Tình trạng'), col('n', 'Số chiếc', 'int')],
      rows: (['NEW', 'GOOD', 'FAIR', 'POOR'] as const).map((c) => ({ c: ({ NEW: 'Mới', GOOD: 'Tốt', FAIR: 'Khá', POOR: 'Kém' } as const)[c], n: n(cond.find((x: Row) => x.condition === c)?.v) })) },
    { title: 'Hàng theo số lượng', columns: [col('name', 'Mẫu'), col('stock', 'Tồn kho', 'int'), col('used', 'Đang giữ / cho thuê', 'int'), col('free', 'Còn lại', 'int')],
      rows: qty.map((q: Row) => ({ name: q.name, stock: q.stock_qty, used: q.used, free: q.stock_qty - q.used })) },
  ];
  // Đợt kiểm kê gần nhất
  const st = (await ctx.db.query(`SELECT * FROM stocktake WHERE ($1::uuid IS NULL OR branch_id IS NULL OR branch_id=$1) ORDER BY created_at DESC LIMIT 1`, [f.branchId ?? null])).rows[0];
  const cards: ReportCard[] = [{ label: 'Tổng số thiết bị', value: n(sTot.total), type: 'int' }];
  if (st) {
    const units = (await ctx.db.query(`SELECT u.id, u.barcode, m.name, u.branch_id AS "branchId", u.status FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id WHERE u.deleted_at IS NULL`)).rows;
    const scanned = new Set((await ctx.db.query('SELECT unit_id FROM stocktake_scan WHERE stocktake_id=$1', [st.id])).rows.map((x: Row) => x.unit_id as string));
    const d = diffStocktake(units, scanned, st.branch_id);
    cards.push({ label: 'Kiểm kê gần nhất', value: st.name, type: 'text', hint: `${st.status === 'CLOSED' ? 'đã đóng' : 'đang mở'} · ${dt(ctx, st.created_at)}` });
    cards.push({ label: 'Khớp / thiếu', value: `${d.matched.length} / ${d.missing.length}`, type: 'text', tone: d.missing.length ? 'warn' : 'good' });
    sections.push({ title: `Kiểm kê "${st.name}": thiết bị chưa quét được`, columns: [col('barcode', 'Mã'), col('name', 'Mẫu'), col('status', 'Trạng thái hệ thống')],
      rows: d.missing.map((u) => ({ barcode: u.barcode, name: u.name, status: UNIT_STATUS_LABEL[u.status as keyof typeof UNIT_STATUS_LABEL] })) });
  }
  return { key: 'inventory', title: 'Tồn kho và kiểm kê', period: snapshotPeriod(ctx, now), cards, sections };
}

// ===== Đăng ký các báo cáo có sẵn =====
const builtIn: ReportDef[] = [
  { key: 'dashboard', title: 'Tổng quan', description: 'Doanh thu hôm nay/tháng, đơn đang thuê, đơn quá hạn, cọc đang giữ, việc hôm nay.', feature: 'reports.basic', permission: 'reports.view', range: 'snapshot', run: dashboard },
  { key: 'revenue', title: 'Doanh thu', description: 'Doanh thu ghi nhận và thực thu theo ngày, tháng, mẫu, danh mục, chi nhánh, nhân viên; tách tiền thuê, phí trễ, hư hỏng, mất, giảm giá.', feature: 'reports.basic', permission: 'reports.finance', range: 'month', groupable: true, branchFilter: true, run: revenue },
  { key: 'debts', title: 'Quá hạn và công nợ', description: 'Đơn quá hạn chưa trả; công nợ theo tuổi nợ 0–7, 8–30, trên 30 ngày.', feature: 'reports.basic', permission: 'reports.finance', range: 'snapshot', branchFilter: true, run: debts },
  { key: 'deposits', title: 'Tiền cọc và tài sản cọc', description: 'Tiền cọc và tài sản thế chấp đang giữ, đơn cần quyết toán.', feature: 'reports.basic', permission: 'reports.finance', range: 'snapshot', run: deposits },
  { key: 'inventory', title: 'Tồn kho và kiểm kê', description: 'Thiết bị theo danh mục và trạng thái, hàng theo số lượng, kết quả kiểm kê gần nhất.', feature: 'reports.basic', permission: 'reports.view', range: 'snapshot', branchFilter: true, run: inventoryReport },
  { key: 'utilization', title: 'Hiệu suất sử dụng', description: 'Tỷ lệ thời gian được thuê; thiết bị ít thuê (gợi ý thanh lý), mẫu thường hết hàng (gợi ý mua thêm).', feature: 'reports.advanced', permission: 'reports.view', range: 'month', branchFilter: true, run: utilizationReport },
  { key: 'roi', title: 'Hoàn vốn (ROI)', description: 'Doanh thu trừ chi phí bảo trì so với giá nhập của từng thiết bị.', feature: 'reports.roi', permission: 'reports.finance', range: 'all', branchFilter: true, run: roiReport },
  { key: 'maintenance', title: 'Bảo trì', description: 'Chi phí, số lần hỏng, thời gian chết, phiếu quá hạn.', feature: 'reports.advanced', permission: 'reports.finance', range: 'month', branchFilter: true, run: maintenanceReport },
  { key: 'customers', title: 'Khách hàng', description: 'Khách thuê nhiều nhất, khách mới, khách hay trả trễ.', feature: 'reports.advanced', permission: 'reports.finance', range: 'all', branchFilter: true, run: customersReport },
];
for (const d of builtIn) registerReport(d);


/** Xuất báo cáo ra Excel. Cùng quyền xem báo cáo; mỗi lần xuất được ghi nhật ký. */
export async function exportReportXlsx(ctx: ServiceCtx, key: string, filter: ReportFilter = {}, now = new Date()): Promise<{ filename: string; data: Buffer }> {
  const result = await runReport(ctx, key, filter, now);
  await audit(ctx, 'report.export', 'report', key, { from: filter.from ?? null, to: filter.to ?? null, groupBy: filter.groupBy ?? null });
  return { filename: `bao-cao-${key}-${localDateKey(now, tzOf(ctx)).replaceAll('-', '')}.xlsx`, data: await reportToXlsx(result) };
}
