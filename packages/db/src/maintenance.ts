import {
  ORDER_KINDS, ORDER_KIND_LABEL, ORDER_STATUS_LABEL, assertOrderTransition, evaluatePlan, findMaintenanceWindow, formatDocNumber, localDateKey, orderCost, pendingChecklist,
  validateParts, validatePlanTriggers,
  type ChecklistItem, type OrderKind, type OrderPart, type OrderStatus, type PlanEvaluation, type PlanTriggers,
} from '@rentpro/core';
import { can } from '@rentpro/tenancy';
import { lockModels } from './booking';
import { insertFee, storePhoto } from './finance';
import { setUnitStatus } from './inventory';
import { pushInbox } from './notify';
import { NotFoundError, ValidationError, audit, guard, need, type ServiceCtx } from './service';

type Row = Record<string, any>;
const DAY = 86_400_000;
const tzOf = (ctx: ServiceCtx) => ctx.timezone ?? 'Asia/Ho_Chi_Minh';
const fmt = (ctx: ServiceCtx) => (d: Date) => new Intl.DateTimeFormat('vi-VN', { timeZone: tzOf(ctx), day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
const MONEY_MAX = 1_000_000_000;

async function nextOrderCode(ctx: ServiceCtx): Promise<string> {
  const year = Number(localDateKey(new Date(), tzOf(ctx)).slice(0, 4));
  const n = (await ctx.db.query(
    `INSERT INTO doc_counter(tenant_id,kind,year,last_value) VALUES ($1,'work_order',$2,1)
     ON CONFLICT (tenant_id,kind,year) DO UPDATE SET last_value = doc_counter.last_value + 1 RETURNING last_value`, [ctx.tenantId, year])).rows[0].last_value;
  return formatDocNumber('BT-{year}-{seq:5}', year, Number(n));
}

// ===== Kế hoạch định kỳ =====
export interface MaintenancePlanInput extends PlanTriggers { name: string; modelId: string; unitId?: string | null; durationHours?: number; checklist?: string[] }

export async function createMaintenancePlan(ctx: ServiceCtx, i: MaintenancePlanInput): Promise<string> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  if (!i.name.trim()) throw new ValidationError('Vui lòng nhập tên kế hoạch.');
  const bad = validatePlanTriggers(i, can(ctx.features, 'maintenance.usage_based'));
  if (bad) throw new ValidationError(bad);
  const dur = i.durationHours ?? 4;
  if (!Number.isInteger(dur) || dur < 1 || dur > 720) throw new ValidationError('Thời lượng bảo trì phải từ 1 đến 720 giờ.');
  const model = (await ctx.db.query('SELECT id, tracked FROM equipment_model WHERE id=$1 AND deleted_at IS NULL', [i.modelId])).rows[0];
  if (!model) throw new NotFoundError('mẫu thiết bị');
  if (!model.tracked) throw new ValidationError('Mẫu quản lý theo số lượng không có từng thiết bị để bảo trì.');
  if (i.unitId && !(await ctx.db.query('SELECT 1 FROM equipment_unit WHERE id=$1 AND model_id=$2 AND deleted_at IS NULL', [i.unitId, i.modelId])).rowCount)
    throw new ValidationError('Thiết bị không thuộc mẫu đã chọn.');
  const checklist = (i.checklist ?? []).map((t) => t.trim()).filter(Boolean).map((text) => ({ text, done: false }));
  const r = await ctx.db.query(
    `INSERT INTO maintenance_plan(tenant_id,name,model_id,unit_id,every_days,every_hours,every_rentals,duration_hours,checklist,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.tenantId, i.name.trim(), i.modelId, i.unitId ?? null, i.everyDays ?? null, i.everyHours ?? null, i.everyRentals ?? null, dur, JSON.stringify(checklist), ctx.userId]);
  await audit(ctx, 'maintenance.plan.create', 'maintenance_plan', r.rows[0].id, { name: i.name.trim(), modelId: i.modelId, unitId: i.unitId ?? null });
  return r.rows[0].id;
}

export async function setMaintenancePlanActive(ctx: ServiceCtx, id: string, active: boolean): Promise<void> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  const r = await ctx.db.query('UPDATE maintenance_plan SET active=$2 WHERE id=$1', [id, active]);
  if (!r.rowCount) throw new NotFoundError('kế hoạch bảo trì');
  await audit(ctx, active ? 'maintenance.plan.enable' : 'maintenance.plan.disable', 'maintenance_plan', id);
}

export interface MaintenancePlanRow {
  id: string; name: string; modelId: string; modelName: string; unitId: string | null; unitBarcode: string | null; active: boolean; durationHours: number;
  everyDays: number | null; everyHours: number | null; everyRentals: number | null; checklist: ChecklistItem[];
}

export async function listMaintenancePlans(ctx: ServiceCtx): Promise<MaintenancePlanRow[]> {
  guard(ctx, 'maintenance.view', 'maintenance');
  return (await ctx.db.query(
    `SELECT p.*, m.name AS model_name, u.barcode FROM maintenance_plan p JOIN equipment_model m ON m.id=p.model_id LEFT JOIN equipment_unit u ON u.id=p.unit_id ORDER BY p.active DESC, p.name`)).rows.map((p: Row) => ({
    id: p.id, name: p.name, modelId: p.model_id, modelName: p.model_name, unitId: p.unit_id, unitBarcode: p.barcode, active: p.active, durationHours: p.duration_hours,
    everyDays: p.every_days, everyHours: p.every_hours, everyRentals: p.every_rentals, checklist: p.checklist,
  }));
}

export interface PlanProgress { planId: string; planName: string; unitId: string; barcode: string; since: Date; usage: { daysSince: number; hoursUsed: number; rentals: number }; evaluation: PlanEvaluation; openOrderId: string | null }

async function progressRows(ctx: ServiceCtx, now: Date, onlyActive = true): Promise<{ plan: Row; rows: PlanProgress[] }[]> {
  const usageBased = can(ctx.features, 'maintenance.usage_based');
  const plans = (await ctx.db.query(`SELECT * FROM maintenance_plan WHERE ($1::boolean = false OR active) ORDER BY created_at`, [onlyActive])).rows;
  const out: { plan: Row; rows: PlanProgress[] }[] = [];
  for (const p of plans) {
    const rows = (await ctx.db.query(
      `WITH targets AS (
         SELECT u.id, u.barcode, u.created_at FROM equipment_unit u WHERE u.deleted_at IS NULL AND u.status NOT IN ('RETIRED','LOST') AND u.model_id=$1 AND ($2::uuid IS NULL OR u.id=$2)),
       last AS (SELECT unit_id, max(finished_at) AS at FROM work_order WHERE plan_id=$3 AND status='DONE' GROUP BY unit_id),
       base AS (SELECT t.id, t.barcode, coalesce(l.at, t.created_at) AS since FROM targets t LEFT JOIN last l ON l.unit_id=t.id)
       SELECT b.id, b.barcode, b.since,
         (SELECT count(*)::int FROM handover_item i JOIN handover h ON h.id=i.handover_id AND h.kind='RETURN' WHERE i.unit_id=b.id AND h.performed_at > b.since) AS rentals,
         (SELECT coalesce(sum(extract(epoch FROM (h.performed_at - bk.delivered_at)) / 3600), 0)::float8 FROM handover_item i
            JOIN handover h ON h.id=i.handover_id AND h.kind='RETURN' JOIN booking bk ON bk.id=h.booking_id
            WHERE i.unit_id=b.id AND h.performed_at > b.since AND bk.delivered_at IS NOT NULL) AS hours,
         (SELECT wo.id FROM work_order wo WHERE wo.plan_id=$3 AND wo.unit_id=b.id AND wo.status IN ('PENDING','IN_PROGRESS')) AS open_id
       FROM base b ORDER BY b.barcode`, [p.model_id, p.unit_id, p.id])).rows;
    out.push({
      plan: p,
      rows: rows.map((r: Row) => {
        const usage = { daysSince: Math.max(0, (now.getTime() - r.since.getTime()) / DAY), hoursUsed: Number(r.hours), rentals: r.rentals };
        return {
          planId: p.id, planName: p.name, unitId: r.id, barcode: r.barcode, since: r.since, usage, openOrderId: r.open_id,
          evaluation: evaluatePlan({ everyDays: p.every_days, everyHours: p.every_hours, everyRentals: p.every_rentals }, usage, usageBased),
        };
      }),
    });
  }
  return out;
}

/** Tiến độ bảo trì của từng thiết bị theo từng kế hoạch (để hiển thị "sắp đến hạn"). */
export async function planProgress(ctx: ServiceCtx, now = new Date()): Promise<PlanProgress[]> {
  guard(ctx, 'maintenance.view', 'maintenance');
  return (await progressRows(ctx, now)).flatMap((x) => x.rows);
}

// ===== Phiếu =====
export interface OrderRow {
  id: string; code: string; unitId: string; barcode: string; modelName: string; kind: OrderKind; kindLabel: string; source: string; status: OrderStatus; statusLabel: string;
  title: string; description: string | null; technicianId: string | null; technicianName: string | null; vendor: string | null; vendorCost: number; laborCost: number;
  parts: OrderPart[]; checklist: ChecklistItem[]; costTotal: number; scheduledStart: Date | null; scheduledEnd: Date | null; dueDate: string | null;
  startedAt: Date | null; finishedAt: Date | null; closeNote: string | null; photosBefore: number; photosAfter: number; bookingId: string | null; bookingCode: string | null;
  chargedFeeId: string | null; createdAt: Date; overdue: boolean;
}

const ORDER_SELECT = `SELECT w.*, to_char(w.due_date, 'YYYY-MM-DD') AS due_text, u.barcode, u.status AS unit_status, m.name AS model_name, t.name AS tech_name, b.code AS booking_code
  FROM work_order w JOIN equipment_unit u ON u.id=w.unit_id JOIN equipment_model m ON m.id=u.model_id LEFT JOIN app_user t ON t.id=w.technician_id LEFT JOIN booking b ON b.id=w.booking_id`;

function toOrder(ctx: ServiceCtx, r: Row): OrderRow {
  const today = localDateKey(new Date(), tzOf(ctx));
  const open = ['PENDING', 'IN_PROGRESS'].includes(r.status);
  const due: string | null = r.due_text ?? null; // DATE đọc dạng chuỗi: pg đổi sang Date theo múi giờ máy chủ sẽ lệch ngày
  return {
    id: r.id, code: r.code, unitId: r.unit_id, barcode: r.barcode, modelName: r.model_name, kind: r.kind, kindLabel: ORDER_KIND_LABEL[r.kind as OrderKind], source: r.source,
    status: r.status, statusLabel: ORDER_STATUS_LABEL[r.status as OrderStatus], title: r.title, description: r.description, technicianId: r.technician_id, technicianName: r.tech_name,
    vendor: r.vendor, vendorCost: Number(r.vendor_cost), laborCost: Number(r.labor_cost), parts: r.parts, checklist: r.checklist, costTotal: Number(r.cost_total),
    scheduledStart: r.scheduled_start, scheduledEnd: r.scheduled_end, dueDate: due, startedAt: r.started_at, finishedAt: r.finished_at, closeNote: r.close_note,
    photosBefore: (r.photos_before as string[]).length, photosAfter: (r.photos_after as string[]).length, bookingId: r.booking_id, bookingCode: r.booking_code,
    chargedFeeId: r.charged_fee_id, createdAt: r.created_at, overdue: open && !!due && due < today,
  };
}

export interface OrderFilter { status?: OrderStatus | 'OPEN'; unitId?: string; technicianId?: string; overdue?: boolean; limit?: number }

export async function listOrders(ctx: ServiceCtx, f: OrderFilter = {}): Promise<OrderRow[]> {
  guard(ctx, 'maintenance.view', 'maintenance');
  const open = f.status === 'OPEN';
  const rows = (await ctx.db.query(
    `${ORDER_SELECT} WHERE ($1::text IS NULL OR w.status = $1) AND (NOT $2::boolean OR w.status IN ('PENDING','IN_PROGRESS','UNREPAIRABLE'))
       AND ($3::uuid IS NULL OR w.unit_id = $3) AND ($4::uuid IS NULL OR w.technician_id = $4)
     ORDER BY CASE w.status WHEN 'IN_PROGRESS' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'UNREPAIRABLE' THEN 2 ELSE 3 END, w.due_date NULLS LAST, w.created_at DESC LIMIT $5`,
    [open ? null : f.status ?? null, open, f.unitId ?? null, f.technicianId ?? null, Math.min(f.limit ?? 100, 500)])).rows.map((r: Row) => toOrder(ctx, r));
  return f.overdue ? rows.filter((r) => r.overdue) : rows;
}

export async function getOrder(ctx: ServiceCtx, id: string): Promise<OrderRow & { unitStatus: string; conflicts: { code: string; start: Date; end: Date }[] }> {
  guard(ctx, 'maintenance.view', 'maintenance');
  const r = (await ctx.db.query(`${ORDER_SELECT} WHERE w.id=$1`, [id])).rows[0];
  if (!r) throw new NotFoundError('phiếu bảo trì');
  return { ...toOrder(ctx, r), unitStatus: r.unit_status, conflicts: await upcomingBookings(ctx, r.unit_id) };
}

/** Đơn thuê sắp tới (chưa giao) đang giữ chiếc này: cảnh báo khi đưa chiếc đi bảo trì. */
async function upcomingBookings(ctx: ServiceCtx, unitId: string): Promise<{ code: string; start: Date; end: Date }[]> {
  return (await ctx.db.query(
    `SELECT b.code, lower(a.period) AS s, upper(a.period) AS e FROM unit_allocation a JOIN booking b ON b.id=a.booking_id
     WHERE a.unit_id=$1 AND a.status IN ('HOLD','CONFIRMED') AND upper(a.period) > now() ORDER BY lower(a.period) LIMIT 10`, [unitId])).rows.map((x: Row) => ({ code: x.code, start: x.s, end: x.e }));
}

export interface OrderInput {
  unitId: string; kind: OrderKind; title: string; description?: string; technicianId?: string | null; vendor?: string | null; dueDate?: string | null;
  checklist?: string[]; windowStart?: Date | null; windowEnd?: Date | null;
}

async function checkTechnician(ctx: ServiceCtx, id: string | null | undefined): Promise<void> {
  if (!id) return;
  if (!(await ctx.db.query('SELECT 1 FROM app_user WHERE id=$1 AND active', [id])).rowCount) throw new ValidationError('Kỹ thuật viên không tồn tại hoặc đã ngưng hoạt động.');
}

/** Chiếm lịch thiết bị trong khung đã chọn; trùng đơn đã đặt thì báo rõ đơn nào. */
async function reserveWindow(ctx: ServiceCtx, workOrderId: string, unit: Row, start: Date, end: Date): Promise<boolean> {
  await lockModels(ctx, [unit.model_id]);
  await ctx.db.query('SAVEPOINT reserve_sp');
  try {
    await ctx.db.query(`INSERT INTO unit_allocation(tenant_id, unit_id, period, status, work_order_id) VALUES ($1,$2,tstzrange($3::timestamptz,$4::timestamptz,'[)'),'MAINTENANCE',$5)`, [ctx.tenantId, unit.id, start, end, workOrderId]);
    await ctx.db.query('RELEASE SAVEPOINT reserve_sp');
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== '23P01') throw e;
    await ctx.db.query('ROLLBACK TO SAVEPOINT reserve_sp');
    return false;
  }
}

async function conflictsMessage(ctx: ServiceCtx, unitId: string, start: Date, end: Date): Promise<string> {
  const c = (await ctx.db.query(
    `SELECT b.code, a.status, w.code AS wo FROM unit_allocation a LEFT JOIN booking b ON b.id=a.booking_id LEFT JOIN work_order w ON w.id=a.work_order_id
     WHERE a.unit_id=$1 AND a.status IN ('HOLD','CONFIRMED','ACTIVE','MAINTENANCE') AND a.period && tstzrange($2::timestamptz,$3::timestamptz,'[)') LIMIT 5`, [unitId, start, end])).rows;
  const names = c.map((x: Row) => (x.code ? `đơn ${x.code}` : `phiếu ${x.wo}`)).join(', ');
  return `Khung giờ bảo trì trùng lịch của ${names || 'một lịch khác'}. Hãy chọn khung khác hoặc dời đơn trước.`;
}

export async function createOrder(ctx: ServiceCtx, i: OrderInput): Promise<string> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  if (!i.title.trim()) throw new ValidationError('Vui lòng nhập tiêu đề phiếu.');
  if (!(ORDER_KINDS as readonly string[]).includes(i.kind)) throw new ValidationError('Loại phiếu không hợp lệ.');
  if (i.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(i.dueDate)) throw new ValidationError('Hạn hoàn thành không hợp lệ.');
  if (!!i.windowStart !== !!i.windowEnd) throw new ValidationError('Khung giờ bảo trì cần cả giờ bắt đầu và giờ kết thúc.');
  if (i.windowStart && i.windowEnd && i.windowEnd <= i.windowStart) throw new ValidationError('Giờ kết thúc phải sau giờ bắt đầu.');
  const unit = (await ctx.db.query('SELECT id, model_id, status, barcode FROM equipment_unit WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [i.unitId])).rows[0];
  if (!unit) throw new NotFoundError('thiết bị');
  if (['RETIRED', 'LOST'].includes(unit.status)) throw new ValidationError(`Thiết bị ${unit.barcode} đã thanh lý hoặc mất, không tạo phiếu được.`);
  await checkTechnician(ctx, i.technicianId);
  const checklist = (i.checklist ?? []).map((t) => t.trim()).filter(Boolean).map((text) => ({ text, done: false }));
  const code = await nextOrderCode(ctx);
  const r = await ctx.db.query(
    `INSERT INTO work_order(tenant_id,code,unit_id,kind,source,title,description,technician_id,vendor,due_date,checklist,scheduled_start,scheduled_end,created_by)
     VALUES ($1,$2,$3,$4,'MANUAL',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [ctx.tenantId, code, unit.id, i.kind, i.title.trim(), i.description?.trim() || null, i.technicianId ?? null, i.vendor?.trim() || null, i.dueDate ?? null, JSON.stringify(checklist), i.windowStart ?? null, i.windowEnd ?? null, ctx.userId]);
  const id = r.rows[0].id as string;
  if (i.windowStart && i.windowEnd && !(await reserveWindow(ctx, id, unit, i.windowStart, i.windowEnd))) throw new ValidationError(await conflictsMessage(ctx, unit.id, i.windowStart, i.windowEnd));
  await audit(ctx, 'maintenance.order.create', 'work_order', id, { code, unit: unit.barcode, kind: i.kind });
  return id;
}

/** Phiếu sửa chữa tự sinh từ biên bản nhận có hư hỏng. Dùng nội bộ (nhân viên quầy nhận hàng không có quyền bảo trì). */
export async function createDamageOrder(ctx: ServiceCtx, i: { unitId: string; bookingId: string; bookingCode: string; notes: string }): Promise<string | null> {
  if (!can(ctx.features, 'maintenance')) return null;
  const barcode = (await ctx.db.query('SELECT barcode FROM equipment_unit WHERE id=$1', [i.unitId])).rows[0]?.barcode;
  const code = await nextOrderCode(ctx);
  const r = await ctx.db.query(
    `INSERT INTO work_order(tenant_id,code,unit_id,kind,source,booking_id,title,description,created_by) VALUES ($1,$2,$3,'REPAIR','DAMAGE',$4,$5,$6,$7) RETURNING id`,
    [ctx.tenantId, code, i.unitId, i.bookingId, `Sửa chữa ${barcode} sau đơn ${i.bookingCode}`, i.notes, ctx.userId]);
  await pushInbox(ctx, { kind: 'MAINTENANCE', title: `Thiết bị ${barcode} hư hỏng khi trả`, body: i.notes, link: `/maintenance/${r.rows[0].id}`, permission: 'maintenance.manage', dedupeKey: `maint:damage:${r.rows[0].id}` });
  return r.rows[0].id;
}

async function lockOrder(ctx: ServiceCtx, id: string): Promise<Row> {
  const o = (await ctx.db.query('SELECT w.*, u.barcode, u.status AS unit_status, u.model_id FROM work_order w JOIN equipment_unit u ON u.id=w.unit_id WHERE w.id=$1 FOR UPDATE OF w', [id])).rows[0];
  if (!o) throw new NotFoundError('phiếu bảo trì');
  return o;
}

const releaseWindow = (ctx: ServiceCtx, id: string) => ctx.db.query(`UPDATE unit_allocation SET status='RELEASED' WHERE work_order_id=$1 AND status='MAINTENANCE'`, [id]);

async function otherActiveOrders(ctx: ServiceCtx, unitId: string, exceptId: string): Promise<number> {
  return (await ctx.db.query(`SELECT count(*)::int n FROM work_order WHERE unit_id=$1 AND id <> $2 AND status IN ('IN_PROGRESS','UNREPAIRABLE')`, [unitId, exceptId])).rows[0].n;
}

/** Bắt đầu làm: đưa thiết bị sang trạng thái Bảo trì. Trả cảnh báo nếu chiếc này đang có đơn thuê sắp tới. */
export async function startOrder(ctx: ServiceCtx, id: string): Promise<{ warnings: string[] }> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  const o = await lockOrder(ctx, id);
  assertOrderTransition(o.status, 'IN_PROGRESS');
  if (['RENTED', 'RESERVED'].includes(o.unit_status)) throw new ValidationError(`Thiết bị ${o.barcode} đang cho thuê hoặc đang được giao, chưa thể bảo trì. Hãy chờ nhận lại thiết bị.`);
  if (['RETIRED', 'LOST'].includes(o.unit_status)) throw new ValidationError(`Thiết bị ${o.barcode} đã thanh lý hoặc mất.`);
  if (o.unit_status !== 'MAINTENANCE') await setUnitStatus(ctx, o.unit_id, 'MAINTENANCE', `Bắt đầu phiếu ${o.code}: ${o.title}`);
  await ctx.db.query(`UPDATE work_order SET status='IN_PROGRESS', started_at=now(), updated_at=now() WHERE id=$1`, [id]);
  await audit(ctx, 'maintenance.order.start', 'work_order', id, { code: o.code });
  const ups = await upcomingBookings(ctx, o.unit_id);
  return { warnings: ups.length ? [`${o.barcode} đang có đơn sắp tới: ${ups.map((u) => `${u.code} (${fmt(ctx)(u.start)})`).join(', ')}. Hãy đổi sang chiếc khác cho các đơn này.`] : [] };
}

export interface FinishInput { note?: string }

export async function finishOrder(ctx: ServiceCtx, id: string, i: FinishInput = {}): Promise<void> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  const o = await lockOrder(ctx, id);
  assertOrderTransition(o.status, 'DONE');
  const left = pendingChecklist(o.checklist);
  if (left.length && !i.note?.trim()) throw new ValidationError(`Còn ${left.length} mục checklist chưa xong: ${left.join('; ')}. Hoàn thành các mục hoặc ghi lý do bỏ qua.`);
  await ctx.db.query(`UPDATE work_order SET status='DONE', finished_at=now(), close_note=$2, updated_at=now() WHERE id=$1`, [id, i.note?.trim() || null]);
  await releaseWindow(ctx, id);
  if (o.unit_status === 'MAINTENANCE' && (await otherActiveOrders(ctx, o.unit_id, id)) === 0) await setUnitStatus(ctx, o.unit_id, 'AVAILABLE', `Hoàn thành phiếu ${o.code}`);
  await audit(ctx, 'maintenance.order.finish', 'work_order', id, { code: o.code, cost: Number(o.cost_total), skipped: left });
}

export async function markUnrepairable(ctx: ServiceCtx, id: string, reason: string): Promise<void> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  if (!reason.trim()) throw new ValidationError('Vui lòng nhập lý do không sửa được.');
  const o = await lockOrder(ctx, id);
  assertOrderTransition(o.status, 'UNREPAIRABLE');
  await ctx.db.query(`UPDATE work_order SET status='UNREPAIRABLE', close_note=$2, updated_at=now() WHERE id=$1`, [id, reason.trim()]);
  await releaseWindow(ctx, id);
  await audit(ctx, 'maintenance.order.unrepairable', 'work_order', id, { code: o.code, reason });
}

/** Thanh lý thiết bị không sửa được: chuyển sang Đã thanh lý. Chặn nếu chiếc còn nằm trong đơn thuê sắp tới. */
export async function disposeOrder(ctx: ServiceCtx, id: string, reason: string): Promise<void> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  guard(ctx, 'inventory.manage', 'inventory', { write: true });
  if (!reason.trim()) throw new ValidationError('Vui lòng nhập lý do thanh lý.');
  const o = await lockOrder(ctx, id);
  assertOrderTransition(o.status, 'DISPOSED');
  const ups = await upcomingBookings(ctx, o.unit_id);
  if (ups.length) throw new ValidationError(`Thiết bị ${o.barcode} còn trong đơn ${ups.map((u) => u.code).join(', ')}. Hãy đổi sang chiếc khác cho các đơn này trước khi thanh lý.`);
  if (o.unit_status !== 'RETIRED') await setUnitStatus(ctx, o.unit_id, 'RETIRED', `Thanh lý theo phiếu ${o.code}: ${reason.trim()}`);
  await ctx.db.query(`UPDATE work_order SET status='DISPOSED', close_note=coalesce(close_note || E'\\n', '') || $2, updated_at=now() WHERE id=$1`, [id, `Thanh lý: ${reason.trim()}`]);
  await audit(ctx, 'maintenance.order.dispose', 'work_order', id, { code: o.code, reason });
}

export async function cancelOrder(ctx: ServiceCtx, id: string, reason: string): Promise<void> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  if (!reason.trim()) throw new ValidationError('Vui lòng nhập lý do hủy phiếu.');
  const o = await lockOrder(ctx, id);
  assertOrderTransition(o.status, 'CANCELLED');
  await ctx.db.query(`UPDATE work_order SET status='CANCELLED', close_note=$2, updated_at=now() WHERE id=$1`, [id, reason.trim()]);
  await releaseWindow(ctx, id);
  await audit(ctx, 'maintenance.order.cancel', 'work_order', id, { code: o.code, reason });
}

export interface OrderPatch {
  title?: string; description?: string | null; technicianId?: string | null; vendor?: string | null; vendorCost?: number; laborCost?: number; dueDate?: string | null;
  parts?: OrderPart[]; checklist?: { text: string; done: boolean }[];
}

/** Sửa phiếu còn mở (chờ / đang làm). Tổng chi phí luôn tính lại ở server. */
export async function updateOrder(ctx: ServiceCtx, id: string, p: OrderPatch): Promise<void> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  const o = await lockOrder(ctx, id);
  if (!['PENDING', 'IN_PROGRESS'].includes(o.status)) throw new ValidationError('Chỉ sửa được phiếu đang chờ hoặc đang làm.');
  const money = (v: number | undefined, label: string) => {
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || v < 0 || v > MONEY_MAX) throw new ValidationError(`${label} phải là số nguyên không âm (VND).`);
    return v;
  };
  const vendorCost = money(p.vendorCost, 'Chi phí sửa ngoài') ?? Number(o.vendor_cost);
  const laborCost = money(p.laborCost, 'Tiền công') ?? Number(o.labor_cost);
  const parts: OrderPart[] = p.parts ?? o.parts;
  const bad = validateParts(parts);
  if (bad) throw new ValidationError(bad);
  if (p.title !== undefined && !p.title.trim()) throw new ValidationError('Tiêu đề phiếu không được để trống.');
  if (p.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)) throw new ValidationError('Hạn hoàn thành không hợp lệ.');
  if (p.technicianId !== undefined) await checkTechnician(ctx, p.technicianId);
  const checklist = p.checklist ?? o.checklist;
  await ctx.db.query(
    `UPDATE work_order SET title=$2, description=$3, technician_id=$4, vendor=$5, vendor_cost=$6, labor_cost=$7, due_date=$8, parts=$9, checklist=$10, cost_total=$11, updated_at=now() WHERE id=$1`,
    [id, p.title?.trim() ?? o.title, p.description === undefined ? o.description : p.description?.trim() || null, p.technicianId === undefined ? o.technician_id : p.technicianId,
      p.vendor === undefined ? o.vendor : p.vendor?.trim() || null, vendorCost, laborCost, p.dueDate === undefined ? o.due_date : p.dueDate || null,
      JSON.stringify(parts), JSON.stringify(checklist), orderCost(parts, laborCost, vendorCost)]);
  await audit(ctx, 'maintenance.order.update', 'work_order', id, { code: o.code, cost: orderCost(parts, laborCost, vendorCost) });
}

/** Đánh dấu một mục checklist xong/chưa (thao tác nhanh trên điện thoại). */
export async function toggleChecklist(ctx: ServiceCtx, id: string, index: number, done: boolean): Promise<void> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  const o = await lockOrder(ctx, id);
  if (!['PENDING', 'IN_PROGRESS'].includes(o.status)) throw new ValidationError('Chỉ sửa được phiếu đang chờ hoặc đang làm.');
  const list = o.checklist as ChecklistItem[];
  if (!list[index]) throw new ValidationError('Mục checklist không tồn tại.');
  list[index] = { ...list[index]!, done };
  await ctx.db.query('UPDATE work_order SET checklist=$2, updated_at=now() WHERE id=$1', [id, JSON.stringify(list)]);
}

export async function addOrderPhotos(ctx: ServiceCtx, id: string, when: 'before' | 'after', photos: { data: Uint8Array }[]): Promise<void> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  if (photos.length === 0) throw new ValidationError('Chưa chọn ảnh.');
  const o = await lockOrder(ctx, id);
  const col = when === 'before' ? 'photos_before' : 'photos_after';
  if (((o[col] as string[]).length + photos.length) > 10) throw new ValidationError('Mỗi phiếu tối đa 10 ảnh trước/sau.');
  need(ctx.storage, 'storage');
  const paths: string[] = [];
  for (const ph of photos) paths.push(await storePhoto(ctx, ph.data, 'maint'));
  await ctx.db.query(`UPDATE work_order SET ${col} = ${col} || $2::text[], updated_at=now() WHERE id=$1`, [id, paths]);
  await audit(ctx, 'maintenance.order.photos', 'work_order', id, { when, count: paths.length });
}

export async function getOrderPhoto(ctx: ServiceCtx, id: string, when: 'before' | 'after', index: number) {
  guard(ctx, 'maintenance.view', 'maintenance');
  const o = (await ctx.db.query('SELECT photos_before, photos_after FROM work_order WHERE id=$1', [id])).rows[0];
  const path = (o?.[when === 'before' ? 'photos_before' : 'photos_after'] as string[] | undefined)?.[index];
  if (!path) throw new NotFoundError('ảnh');
  const f = await need(ctx.storage, 'storage').get(path);
  if (!f) throw new NotFoundError('ảnh');
  return f;
}

/** Chuyển chi phí sửa chữa do khách gây ra thành khoản phí hư hỏng trên đơn thuê. Cần quyền xử lý tiền nên kỹ thuật viên không làm được. */
export async function chargeCustomer(ctx: ServiceCtx, id: string, i: { amount?: number; description?: string } = {}): Promise<string> {
  guard(ctx, 'booking.handover', 'payments', { write: true });
  guard(ctx, 'maintenance.view', 'maintenance');
  const o = await lockOrder(ctx, id);
  if (!o.booking_id) throw new ValidationError('Phiếu này không gắn với đơn thuê nào nên không tính phí cho khách được.');
  if (o.charged_fee_id) {
    const f = (await ctx.db.query('SELECT voided_at FROM booking_fee WHERE id=$1', [o.charged_fee_id])).rows[0];
    if (f && !f.voided_at) throw new ValidationError('Phiếu này đã được tính phí cho khách. Muốn tính lại, hãy hủy khoản phí cũ trên đơn.');
  }
  const amount = i.amount ?? Number(o.cost_total);
  if (!Number.isInteger(amount) || amount <= 0) throw new ValidationError('Chưa có chi phí để tính cho khách. Hãy nhập linh kiện/tiền công trong phiếu hoặc nhập số tiền.');
  const feeId = await insertFee(ctx, o.booking_id, { kind: 'DAMAGE', description: i.description?.trim() || `Sửa chữa ${o.barcode} (phiếu ${o.code}): ${o.title}`, amount, unitId: o.unit_id });
  await ctx.db.query('UPDATE work_order SET charged_fee_id=$2, updated_at=now() WHERE id=$1', [id, feeId]);
  await audit(ctx, 'maintenance.order.charge', 'work_order', id, { code: o.code, bookingId: o.booking_id, amount, feeId });
  return feeId;
}

/** Quét mã thiết bị: trả phiếu đang mở của chiếc đó (nếu có) hoặc thông tin chiếc để tạo phiếu mới. */
export async function lookupForMaintenance(ctx: ServiceCtx, barcode: string): Promise<{ unitId: string; barcode: string; modelName: string; status: string; openOrderId: string | null } | null> {
  guard(ctx, 'maintenance.view', 'maintenance');
  const u = (await ctx.db.query(
    `SELECT u.id, u.barcode, u.status, m.name AS model_name, (SELECT w.id FROM work_order w WHERE w.unit_id=u.id AND w.status IN ('PENDING','IN_PROGRESS','UNREPAIRABLE') ORDER BY w.created_at DESC LIMIT 1) AS open_id
     FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id WHERE upper(u.barcode)=upper($1) AND u.deleted_at IS NULL`, [barcode.trim()])).rows[0];
  return u ? { unitId: u.id, barcode: u.barcode, modelName: u.model_name, status: u.status, openOrderId: u.open_id } : null;
}

export async function listTechnicians(ctx: ServiceCtx): Promise<{ id: string; name: string; role: string }[]> {
  guard(ctx, 'maintenance.view', 'maintenance');
  return (await ctx.db.query(`SELECT id, name, role FROM app_user WHERE active ORDER BY (role='TECHNICIAN') DESC, name`)).rows;
}

export interface MaintenanceSummary { pending: number; inProgress: number; unrepairable: number; overdue: number; due: number }

export async function maintenanceSummary(ctx: ServiceCtx, now = new Date()): Promise<MaintenanceSummary> {
  guard(ctx, 'maintenance.view', 'maintenance');
  const c = (await ctx.db.query(`SELECT status, count(*)::int n FROM work_order WHERE status IN ('PENDING','IN_PROGRESS','UNREPAIRABLE') GROUP BY status`)).rows;
  const n = (s: string) => c.find((x: Row) => x.status === s)?.n ?? 0;
  const orders = await listOrders(ctx, { status: 'OPEN' });
  const due = (await progressRows(ctx, now)).flatMap((x) => x.rows).filter((r) => r.evaluation.due && !r.openOrderId).length;
  return { pending: n('PENDING'), inProgress: n('IN_PROGRESS'), unrepairable: n('UNREPAIRABLE'), overdue: orders.filter((o) => o.overdue).length, due };
}

// ===== Tác vụ nền hằng ngày =====
export interface MaintenanceScanResult { created: number; scheduled: number; unscheduled: number; overdueAlerts: number }

/**
 * Tạo phiếu cho thiết bị đến hạn bảo trì và cố xếp khung giờ vào lịch (không trùng đơn đã đặt). Không xếp được thì vẫn tạo phiếu
 * (chưa có khung) kèm cảnh báo cho quản lý. Chạy lặp lại không tạo trùng nhờ chỉ mục duy nhất của phiếu đang mở.
 */
export async function scanMaintenance(ctx: ServiceCtx, now: Date): Promise<MaintenanceScanResult> {
  guard(ctx, 'maintenance.manage', 'maintenance', { write: true });
  const out: MaintenanceScanResult = { created: 0, scheduled: 0, unscheduled: 0, overdueAlerts: 0 };
  const tz = tzOf(ctx);
  for (const { plan, rows } of await progressRows(ctx, now)) {
    for (const r of rows) {
      if (!r.evaluation.due || r.openOrderId) continue;
      const unit = (await ctx.db.query('SELECT id, model_id, barcode, status FROM equipment_unit WHERE id=$1 FOR UPDATE', [r.unitId])).rows[0];
      const code = await nextOrderCode(ctx);
      const due = new Date(now.getTime() + 7 * DAY);
      const ins = await ctx.db.query(
        `INSERT INTO work_order(tenant_id,code,unit_id,kind,source,plan_id,title,description,checklist,due_date)
         VALUES ($1,$2,$3,'PERIODIC','PLAN',$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, unit_id, plan_id) WHERE plan_id IS NOT NULL AND status IN ('PENDING','IN_PROGRESS') DO NOTHING RETURNING id`,
        [ctx.tenantId, code, r.unitId, plan.id, `${plan.name} — ${r.barcode}`, `Đến hạn bảo trì: ${r.evaluation.reasons.join('; ')}.`, JSON.stringify(plan.checklist), localDateKey(due, tz)]);
      const id = ins.rows[0]?.id as string | undefined;
      if (!id) continue;
      out.created++;
      const busy = (await ctx.db.query(
        `SELECT lower(period) AS s, upper(period) AS e FROM unit_allocation WHERE unit_id=$1 AND status IN ('HOLD','CONFIRMED','ACTIVE','MAINTENANCE') AND upper(period) > $2`, [r.unitId, now])).rows;
      const win = findMaintenanceWindow({ from: now, durationHours: plan.duration_hours, busy: busy.map((b: Row) => ({ start: b.s, end: b.e })), timeZone: tz });
      let placed = false;
      if (win && unit) {
        placed = await reserveWindow(ctx, id, unit, win.start, win.end);
        if (placed) await ctx.db.query('UPDATE work_order SET scheduled_start=$2, scheduled_end=$3 WHERE id=$1', [id, win.start, win.end]);
      }
      if (placed) out.scheduled++; else out.unscheduled++;
      await pushInbox(ctx, {
        kind: 'MAINTENANCE', title: `${r.barcode} đến hạn bảo trì`,
        body: placed ? `${r.evaluation.reasons.join('; ')}. Đã xếp lịch ${fmt(ctx)(win!.start)} – ${fmt(ctx)(win!.end)}.` : `${r.evaluation.reasons.join('; ')}. CHƯA xếp được lịch vì trùng các đơn đã đặt, hãy sắp xếp thủ công.`,
        link: `/maintenance/${id}`, permission: 'maintenance.manage', dedupeKey: `maint:due:${id}`,
      });
    }
  }
  const today = localDateKey(now, tz);
  for (const o of await listOrders(ctx, { status: 'OPEN', limit: 500 })) {
    if (o.overdue && ['PENDING', 'IN_PROGRESS'].includes(o.status)) {
      const fresh = await pushInbox(ctx, { kind: 'MAINTENANCE', title: `Phiếu ${o.code} quá hạn`, body: `${o.barcode} · ${o.title} · hạn ${o.dueDate}`, link: `/maintenance/${o.id}`, permission: 'maintenance.manage', dedupeKey: `maint:overdue:${o.id}` });
      if (fresh) out.overdueAlerts++;
    }
  }
  void today;
  return out;
}
