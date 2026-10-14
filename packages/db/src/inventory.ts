import {
  DEFAULT_BARCODE_PATTERN, assertTransition, diffStocktake, formatBarcode, isValidBarcode, normalizeScan,
  readWorkbook, validateImportRows, buildUnitsExport, renderLabelSheet, DEFAULT_LABEL, UNIT_STATUS_LABEL,
  type ImportItem, type LabelOptions, type RowError, type UnitStatus,
} from '@rentpro/core';
import { assertWithinLimit, nearLimit } from '@rentpro/tenancy';
import { NotFoundError, ValidationError, audit, guard, type ServiceCtx } from './service';

// ===== Danh mục =====
export async function createCategory(ctx: ServiceCtx, input: { name: string; parentId?: string | null }) {
  guard(ctx, 'inventory.manage', 'inventory', { write: true });
  const name = input.name.trim();
  if (!name) throw new ValidationError('Tên danh mục không được để trống.');
  const r = await ctx.db.query(
    'INSERT INTO category(tenant_id,parent_id,name) VALUES ($1,$2,$3) RETURNING id',
    [ctx.tenantId, input.parentId ?? null, name],
  );
  await audit(ctx, 'category.create', 'category', r.rows[0].id, { name });
  return r.rows[0].id as string;
}

export interface CategoryNode { id: string; name: string; parentId: string | null; children: CategoryNode[] }

export async function listCategoryTree(ctx: ServiceCtx): Promise<CategoryNode[]> {
  guard(ctx, 'inventory.view', 'inventory');
  const { rows } = await ctx.db.query('SELECT id, name, parent_id FROM category WHERE deleted_at IS NULL ORDER BY sort_order, name');
  const nodes = new Map<string, CategoryNode>(rows.map((r) => [r.id, { id: r.id, name: r.name, parentId: r.parent_id, children: [] }]));
  const roots: CategoryNode[] = [];
  for (const n of nodes.values()) (n.parentId && nodes.get(n.parentId) ? nodes.get(n.parentId)!.children : roots).push(n);
  return roots;
}

// ===== Mẫu thiết bị =====
export interface ModelInput {
  name: string; brand?: string | null; categoryId?: string | null; description?: string | null;
  bufferMinutes?: number; tracked?: boolean; stockQty?: number; barcodePrefix?: string | null;
  compensationValue?: number | null; accessories?: { name: string; qty: number }[];
  maintenanceEveryDays?: number | null; maintenanceEveryHours?: number | null; maintenanceEveryRentals?: number | null;
}

export async function createModel(ctx: ServiceCtx, i: ModelInput) {
  guard(ctx, 'inventory.manage', 'inventory', { write: true });
  if (!i.name.trim()) throw new ValidationError('Tên mẫu không được để trống.');
  if (i.barcodePrefix && !/^[A-Z0-9]{1,8}$/.test(i.barcodePrefix)) throw new ValidationError('Tiền tố mã vạch gồm 1–8 ký tự A–Z, 0–9.');
  const r = await ctx.db.query(
    `INSERT INTO equipment_model(tenant_id,category_id,name,brand,description,buffer_minutes,tracked,stock_qty,barcode_prefix,
       compensation_value,accessories,maintenance_every_days,maintenance_every_hours,maintenance_every_rentals)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.tenantId, i.categoryId ?? null, i.name.trim(), i.brand ?? null, i.description ?? null, i.bufferMinutes ?? 0, i.tracked ?? true,
      i.stockQty ?? 0, i.barcodePrefix ?? null, i.compensationValue ?? null, JSON.stringify(i.accessories ?? []),
      i.maintenanceEveryDays ?? null, i.maintenanceEveryHours ?? null, i.maintenanceEveryRentals ?? null],
  );
  await audit(ctx, 'model.create', 'equipment_model', r.rows[0].id, { name: i.name });
  return r.rows[0].id as string;
}

export interface ModelRow {
  id: string; name: string; brand: string | null; categoryName: string | null; tracked: boolean; stockQty: number;
  counts: Partial<Record<UnitStatus, number>>; total: number;
}

export async function listModels(ctx: ServiceCtx, f: { q?: string; categoryId?: string } = {}): Promise<ModelRow[]> {
  guard(ctx, 'inventory.view', 'inventory');
  const { rows } = await ctx.db.query(
    `SELECT m.id, m.name, m.brand, m.tracked, m.stock_qty, c.name AS category_name,
            COALESCE(jsonb_object_agg(s.status, s.n) FILTER (WHERE s.status IS NOT NULL), '{}') AS counts
     FROM equipment_model m
     LEFT JOIN category c ON c.id = m.category_id
     LEFT JOIN LATERAL (SELECT status, count(*)::int AS n FROM equipment_unit u
                        WHERE u.model_id = m.id AND u.deleted_at IS NULL GROUP BY status) s ON true
     WHERE m.deleted_at IS NULL
       AND ($1::text IS NULL OR m.name ILIKE '%' || $1 || '%' OR m.brand ILIKE '%' || $1 || '%')
       AND ($2::uuid IS NULL OR m.category_id = $2)
     GROUP BY m.id, c.name ORDER BY m.name`,
    [f.q || null, f.categoryId || null],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, brand: r.brand, categoryName: r.category_name, tracked: r.tracked, stockQty: r.stock_qty, counts: r.counts,
    total: Object.values(r.counts as Record<string, number>).reduce((a, b) => a + b, 0),
  }));
}

// ===== Thiết bị =====
export async function countUnits(ctx: ServiceCtx): Promise<number> {
  return (await ctx.db.query('SELECT count(*)::int AS n FROM equipment_unit WHERE deleted_at IS NULL')).rows[0].n;
}

/** Cảnh báo khi dùng ≥ 80% hạn mức thiết bị. */
export async function equipmentUsage(ctx: ServiceCtx) {
  const used = await countUnits(ctx);
  return { used, limit: ctx.limits.equipment, near: nearLimit(ctx.limits, 'equipment', used) };
}

/** Cấp mã kế tiếp theo tiền tố; bỏ qua mã đã bị dùng thủ công. Atomic nhờ UPSERT trên bộ đếm. */
async function nextBarcode(ctx: ServiceCtx, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const n = (await ctx.db.query(
      `INSERT INTO barcode_counter(tenant_id,prefix,last_value) VALUES ($1,$2,1)
       ON CONFLICT (tenant_id,prefix) DO UPDATE SET last_value = barcode_counter.last_value + 1 RETURNING last_value`,
      [ctx.tenantId, prefix],
    )).rows[0].last_value as number;
    const code = formatBarcode(ctx.barcodePattern ?? DEFAULT_BARCODE_PATTERN, prefix, Number(n));
    if (!(await ctx.db.query('SELECT 1 FROM equipment_unit WHERE barcode=$1', [code])).rowCount) return code;
  }
  throw new Error('Không cấp được mã vạch mới, vui lòng thử lại.');
}

export interface UnitInput {
  modelId: string; quantity?: number; serial?: string | null; barcode?: string | null; branchId?: string | null;
  purchaseDate?: string | null; purchasePrice?: number | null; compensationValue?: number | null;
  condition?: 'NEW' | 'GOOD' | 'FAIR' | 'POOR'; location?: string | null; notes?: string | null;
}

async function insertUnit(ctx: ServiceCtx, model: { id: string; barcode_prefix: string | null; compensation_value: string | null }, i: UnitInput, barcode?: string) {
  const code = barcode ?? (i.barcode ? normalizeScan(i.barcode) : await nextBarcode(ctx, model.barcode_prefix ?? 'EQ'));
  if (!isValidBarcode(code)) throw new ValidationError('Mã vạch không hợp lệ (ASCII, không khoảng trắng, tối đa 40 ký tự).');
  try {
    const r = await ctx.db.query(
      `INSERT INTO equipment_unit(tenant_id,model_id,branch_id,serial,barcode,purchase_date,purchase_price,compensation_value,condition,location,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [ctx.tenantId, model.id, i.branchId ?? null, i.serial || null, code, i.purchaseDate ?? null, i.purchasePrice ?? null,
        i.compensationValue ?? model.compensation_value, i.condition ?? 'GOOD', i.location ?? null, i.notes ?? null],
    );
    await ctx.db.query('INSERT INTO unit_status_log(tenant_id,unit_id,to_status,user_id,reason) VALUES ($1,$2,$3,$4,$5)',
      [ctx.tenantId, r.rows[0].id, 'AVAILABLE', ctx.userId, 'Tạo mới']);
    return { id: r.rows[0].id as string, barcode: code };
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    if (err.code === '23505' && err.constraint === 'equipment_unit_tenant_id_barcode_key') throw new ValidationError(`Mã vạch "${code}" đã tồn tại.`);
    if (err.code === '23505') throw new ValidationError(`Serial "${i.serial}" của mẫu này đã tồn tại.`);
    throw e;
  }
}

export async function createUnits(ctx: ServiceCtx, i: UnitInput) {
  guard(ctx, 'inventory.manage', 'inventory', { write: true });
  const qty = i.quantity ?? 1;
  if (!Number.isInteger(qty) || qty < 1 || qty > 500) throw new ValidationError('Số lượng phải từ 1 đến 500.');
  if (qty > 1 && (i.serial || i.barcode)) throw new ValidationError('Tạo nhiều thiết bị một lúc thì không nhập serial hoặc mã vạch riêng.');
  const model = (await ctx.db.query('SELECT id, tracked, barcode_prefix, compensation_value FROM equipment_model WHERE id=$1 AND deleted_at IS NULL', [i.modelId])).rows[0];
  if (!model) throw new NotFoundError('mẫu thiết bị');
  if (!model.tracked) throw new ValidationError('Mẫu này quản lý theo số lượng, không tạo từng thiết bị.');
  assertWithinLimit(ctx.limits, 'equipment', await countUnits(ctx), qty);
  const out: { id: string; barcode: string }[] = [];
  for (let n = 0; n < qty; n++) out.push(await insertUnit(ctx, model, i));
  await audit(ctx, 'unit.create', 'equipment_model', model.id, { quantity: qty });
  return out;
}

export async function transitionUnit(ctx: ServiceCtx, unitId: string, to: UnitStatus, opts: { reason?: string; system?: boolean } = {}) {
  guard(ctx, 'inventory.manage', 'inventory', { write: true });
  // Khóa hàng để hai người đổi cùng lúc không ghi đè nhau.
  const u = (await ctx.db.query('SELECT status FROM equipment_unit WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [unitId])).rows[0];
  if (!u) throw new NotFoundError('thiết bị');
  assertTransition(u.status, to, { system: opts.system });
  if ((to === 'MAINTENANCE' || to === 'LOST' || to === 'RETIRED') && !opts.reason?.trim()) throw new ValidationError('Vui lòng nhập lý do.');
  await ctx.db.query('UPDATE equipment_unit SET status=$2 WHERE id=$1', [unitId, to]);
  await ctx.db.query('INSERT INTO unit_status_log(tenant_id,unit_id,from_status,to_status,user_id,reason) VALUES ($1,$2,$3,$4,$5,$6)',
    [ctx.tenantId, unitId, u.status, to, ctx.userId, opts.reason?.trim() ?? null]);
  await audit(ctx, 'unit.status', 'equipment_unit', unitId, { from: u.status, to, reason: opts.reason });
}

export interface UnitRow {
  id: string; barcode: string; serial: string | null; status: UnitStatus; modelId: string; modelName: string;
  categoryName: string | null; branchId: string | null; branchName: string | null; condition: string;
}

export interface UnitFilter { q?: string; status?: string; modelId?: string; categoryId?: string; branchId?: string; page?: number; pageSize?: number }

export async function listUnits(ctx: ServiceCtx, f: UnitFilter = {}): Promise<{ rows: UnitRow[]; total: number }> {
  guard(ctx, 'inventory.view', 'inventory');
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 200);
  const offset = (Math.max(f.page ?? 1, 1) - 1) * pageSize;
  const where = `u.deleted_at IS NULL
    AND ($1::text IS NULL OR u.barcode ILIKE '%' || $1 || '%' OR u.serial ILIKE '%' || $1 || '%' OR m.name ILIKE '%' || $1 || '%')
    AND ($2::text IS NULL OR u.status = $2) AND ($3::uuid IS NULL OR u.model_id = $3)
    AND ($4::uuid IS NULL OR m.category_id = $4) AND ($5::uuid IS NULL OR u.branch_id = $5)`;
  const args = [f.q || null, f.status || null, f.modelId || null, f.categoryId || null, f.branchId || null];
  const total = (await ctx.db.query(`SELECT count(*)::int AS n FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id WHERE ${where}`, args)).rows[0].n;
  const { rows } = await ctx.db.query(
    `SELECT u.id, u.barcode, u.serial, u.status, u.model_id, m.name AS model_name, c.name AS category_name, u.branch_id, b.name AS branch_name, u.condition
     FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id
     LEFT JOIN category c ON c.id=m.category_id LEFT JOIN branch b ON b.id=u.branch_id
     WHERE ${where} ORDER BY m.name, u.barcode LIMIT ${pageSize} OFFSET ${offset}`, args);
  return {
    total,
    rows: rows.map((r) => ({ id: r.id, barcode: r.barcode, serial: r.serial, status: r.status, modelId: r.model_id, modelName: r.model_name,
      categoryName: r.category_name, branchId: r.branch_id, branchName: r.branch_name, condition: r.condition })),
  };
}

export async function getUnitDetail(ctx: ServiceCtx, id: string) {
  guard(ctx, 'inventory.view', 'inventory');
  const unit = (await ctx.db.query(
    `SELECT u.*, m.name AS model_name FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id WHERE u.id=$1 AND u.deleted_at IS NULL`, [id])).rows[0];
  if (!unit) throw new NotFoundError('thiết bị');
  const history = (await ctx.db.query('SELECT from_status, to_status, reason, created_at, user_id FROM unit_status_log WHERE unit_id=$1 ORDER BY id DESC', [id])).rows;
  return { unit, history };
}

/** Tra theo mã quét (máy quét USB hoặc camera). */
export async function findUnitByBarcode(ctx: ServiceCtx, raw: string) {
  guard(ctx, 'inventory.view', 'inventory.barcode');
  const code = normalizeScan(raw);
  const r = await ctx.db.query(
    `SELECT u.id, u.barcode, u.status, m.name AS model_name FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id
     WHERE u.barcode=$1 AND u.deleted_at IS NULL`, [code]);
  return r.rows[0] ? { id: r.rows[0].id as string, barcode: r.rows[0].barcode as string, status: r.rows[0].status as UnitStatus, modelName: r.rows[0].model_name as string } : null;
}

export async function softDeleteUnit(ctx: ServiceCtx, id: string, reason: string) {
  guard(ctx, 'inventory.manage', 'inventory', { write: true });
  if (!reason.trim()) throw new ValidationError('Vui lòng nhập lý do xóa.');
  const u = (await ctx.db.query('SELECT status FROM equipment_unit WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
  if (!u) throw new NotFoundError('thiết bị');
  if (!['AVAILABLE', 'RETIRED', 'LOST'].includes(u.status)) throw new ValidationError(`Không xóa được thiết bị đang ở trạng thái "${UNIT_STATUS_LABEL[u.status as UnitStatus]}".`);
  if ((await ctx.db.query("SELECT 1 FROM unit_allocation WHERE unit_id=$1 AND status IN ('HOLD','CONFIRMED','ACTIVE','MAINTENANCE')", [id])).rowCount)
    throw new ValidationError('Thiết bị còn lịch đặt hoặc bảo trì, hãy hủy lịch trước.');
  await ctx.db.query('UPDATE equipment_unit SET deleted_at = now() WHERE id=$1', [id]);
  await audit(ctx, 'unit.delete', 'equipment_unit', id, { reason });
}

// ===== Tem nhãn =====
export async function labelSheet(ctx: ServiceCtx, unitIds: string[], opts: LabelOptions = DEFAULT_LABEL): Promise<string> {
  guard(ctx, 'inventory.view', 'inventory.barcode');
  if (unitIds.length === 0 || unitIds.length > 500) throw new ValidationError('Chọn từ 1 đến 500 thiết bị để in tem.');
  const { rows } = await ctx.db.query(
    `SELECT u.barcode, u.serial, m.name FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id
     WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL ORDER BY u.barcode`, [unitIds]);
  return renderLabelSheet(rows.map((r) => ({ barcode: r.barcode, name: r.name, subtitle: r.serial ?? undefined })), opts);
}

// ===== Nhập / xuất Excel =====
export interface ImportPreview { total: number; valid: number; errors: RowError[]; items: { row: number; item: ImportItem }[] }

export async function previewImport(ctx: ServiceCtx, file: Buffer | ArrayBuffer): Promise<ImportPreview & { fileError?: string }> {
  guard(ctx, 'inventory.manage', 'inventory');
  const { rows, error } = await readWorkbook(file);
  if (error) return { total: 0, valid: 0, errors: [], items: [], fileError: error };
  if (rows.length > 2000) return { total: rows.length, valid: 0, errors: [], items: [], fileError: 'Mỗi lần nhập tối đa 2.000 dòng.' };
  const branches = (await ctx.db.query('SELECT lower(name) AS n FROM branch WHERE deleted_at IS NULL')).rows.map((r) => r.n as string);
  const barcodes = (await ctx.db.query('SELECT barcode FROM equipment_unit')).rows.map((r) => r.barcode as string);
  const serials = (await ctx.db.query(
    `SELECT lower(m.name) || '|' || lower(u.serial) AS k FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id
     WHERE u.serial IS NOT NULL AND u.deleted_at IS NULL`)).rows.map((r) => r.k as string);
  const v = validateImportRows(rows, { branchNames: new Set(branches), existingBarcodes: new Set(barcodes), existingSerials: new Set(serials) });
  return { total: rows.length, valid: v.items.length, errors: v.errors, items: v.items };
}

/** Nhập toàn bộ hoặc không gì cả: có lỗi thì từ chối, kể cả khi vượt hạn mức gói. */
export async function commitImport(ctx: ServiceCtx, file: Buffer | ArrayBuffer) {
  guard(ctx, 'inventory.manage', 'inventory', { write: true });
  const p = await previewImport(ctx, file);
  if (p.fileError) throw new ValidationError(p.fileError);
  if (p.errors.length) throw new ValidationError(`File còn ${p.errors.length} lỗi, hãy sửa rồi nhập lại.`);
  if (p.items.length === 0) throw new ValidationError('File không có dòng dữ liệu.');
  assertWithinLimit(ctx.limits, 'equipment', await countUnits(ctx), p.items.length);

  const cats = new Map<string, string>((await ctx.db.query('SELECT lower(name) AS n, id FROM category WHERE deleted_at IS NULL')).rows.map((r) => [r.n, r.id]));
  const models = new Map<string, { id: string; barcode_prefix: string | null; compensation_value: string | null }>(
    (await ctx.db.query('SELECT lower(name) AS n, id, barcode_prefix, compensation_value FROM equipment_model WHERE deleted_at IS NULL')).rows.map((r) => [r.n, r]));
  const branches = new Map<string, string>((await ctx.db.query('SELECT lower(name) AS n, id FROM branch WHERE deleted_at IS NULL')).rows.map((r) => [r.n, r.id]));

  let created = 0;
  for (const { item } of p.items) {
    let catId: string | null = null;
    if (item.category) {
      catId = cats.get(item.category.toLowerCase()) ?? null;
      if (!catId) {
        catId = (await ctx.db.query('INSERT INTO category(tenant_id,name) VALUES ($1,$2) RETURNING id', [ctx.tenantId, item.category])).rows[0].id;
        cats.set(item.category.toLowerCase(), catId!);
      }
    }
    let model = models.get(item.model.toLowerCase());
    if (!model) {
      const id = (await ctx.db.query('INSERT INTO equipment_model(tenant_id,category_id,name,brand) VALUES ($1,$2,$3,$4) RETURNING id', [ctx.tenantId, catId, item.model, item.brand])).rows[0].id;
      model = { id, barcode_prefix: null, compensation_value: null };
      models.set(item.model.toLowerCase(), model);
    }
    await insertUnit(ctx, model, {
      modelId: model.id, serial: item.serial, barcode: item.barcode, branchId: item.branch ? branches.get(item.branch.toLowerCase()) : null,
      purchaseDate: item.purchaseDate, purchasePrice: item.purchasePrice, compensationValue: item.compensation, condition: item.condition, notes: item.notes,
    });
    created++;
  }
  await audit(ctx, 'inventory.import', 'equipment_unit', 'bulk', { created });
  return { created };
}

export async function exportUnits(ctx: ServiceCtx): Promise<Buffer> {
  guard(ctx, 'inventory.view', 'inventory');
  const { rows } = await ctx.db.query(
    `SELECT u.barcode, m.name AS model, c.name AS category, u.serial, u.status, b.name AS branch, u.purchase_price AS price, u.purchase_date::text AS purchase_date
     FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id LEFT JOIN category c ON c.id=m.category_id LEFT JOIN branch b ON b.id=u.branch_id
     WHERE u.deleted_at IS NULL ORDER BY m.name, u.barcode`);
  return buildUnitsExport(rows.map((r) => ({
    barcode: r.barcode, model: r.model, category: r.category, serial: r.serial, status: UNIT_STATUS_LABEL[r.status as UnitStatus],
    branch: r.branch, price: r.price === null ? null : Number(r.price), purchaseDate: r.purchase_date,
  })));
}

// ===== Kiểm kê =====
export async function startStocktake(ctx: ServiceCtx, input: { name: string; branchId?: string | null }) {
  guard(ctx, 'inventory.stocktake', 'inventory.stocktake', { write: true });
  if (!input.name.trim()) throw new ValidationError('Vui lòng đặt tên đợt kiểm kê.');
  const r = await ctx.db.query('INSERT INTO stocktake(tenant_id,branch_id,name,created_by) VALUES ($1,$2,$3,$4) RETURNING id',
    [ctx.tenantId, input.branchId ?? null, input.name.trim(), ctx.userId]);
  await audit(ctx, 'stocktake.start', 'stocktake', r.rows[0].id, { name: input.name });
  return r.rows[0].id as string;
}

export type ScanOutcome = 'MATCHED' | 'DUPLICATE' | 'WRONG_BRANCH' | 'UNEXPECTED' | 'UNKNOWN';

export async function scanStocktake(ctx: ServiceCtx, stocktakeId: string, raw: string): Promise<{ outcome: ScanOutcome; barcode: string; name?: string }> {
  guard(ctx, 'inventory.stocktake', 'inventory.stocktake', { write: true });
  const st = (await ctx.db.query('SELECT branch_id, status FROM stocktake WHERE id=$1', [stocktakeId])).rows[0];
  if (!st) throw new NotFoundError('đợt kiểm kê');
  if (st.status !== 'OPEN') throw new ValidationError('Đợt kiểm kê đã đóng.');
  const code = normalizeScan(raw);
  const u = (await ctx.db.query(
    `SELECT u.id, u.branch_id, u.status, m.name FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id WHERE u.barcode=$1 AND u.deleted_at IS NULL`, [code])).rows[0];
  if (!u) return { outcome: 'UNKNOWN', barcode: code };
  const ins = await ctx.db.query(
    'INSERT INTO stocktake_scan(tenant_id,stocktake_id,unit_id,scanned_by) VALUES ($1,$2,$3,$4) ON CONFLICT (stocktake_id, unit_id) DO NOTHING',
    [ctx.tenantId, stocktakeId, u.id, ctx.userId]);
  if (!ins.rowCount) return { outcome: 'DUPLICATE', barcode: code, name: u.name };
  if (st.branch_id && u.branch_id !== st.branch_id) return { outcome: 'WRONG_BRANCH', barcode: code, name: u.name };
  if (['RENTED', 'RESERVED', 'RETIRED', 'LOST'].includes(u.status)) return { outcome: 'UNEXPECTED', barcode: code, name: u.name };
  return { outcome: 'MATCHED', barcode: code, name: u.name };
}

export async function stocktakeReport(ctx: ServiceCtx, stocktakeId: string) {
  guard(ctx, 'inventory.stocktake', 'inventory.stocktake');
  const st = (await ctx.db.query('SELECT * FROM stocktake WHERE id=$1', [stocktakeId])).rows[0];
  if (!st) throw new NotFoundError('đợt kiểm kê');
  const units = (await ctx.db.query(
    `SELECT u.id, u.barcode, m.name, u.branch_id AS "branchId", u.status FROM equipment_unit u JOIN equipment_model m ON m.id=u.model_id WHERE u.deleted_at IS NULL`)).rows;
  const scanned = new Set((await ctx.db.query('SELECT unit_id FROM stocktake_scan WHERE stocktake_id=$1', [stocktakeId])).rows.map((r) => r.unit_id as string));
  return { stocktake: st, result: diffStocktake(units, scanned, st.branch_id) };
}

export async function closeStocktake(ctx: ServiceCtx, stocktakeId: string) {
  guard(ctx, 'inventory.stocktake', 'inventory.stocktake', { write: true });
  const r = await ctx.db.query("UPDATE stocktake SET status='CLOSED', closed_at=now() WHERE id=$1 AND status='OPEN' RETURNING id", [stocktakeId]);
  if (!r.rowCount) throw new ValidationError('Đợt kiểm kê không tồn tại hoặc đã đóng.');
  await audit(ctx, 'stocktake.close', 'stocktake', stocktakeId);
}

export async function listBranches(ctx: ServiceCtx): Promise<{ id: string; name: string }[]> {
  guard(ctx, 'inventory.view', 'inventory');
  return (await ctx.db.query('SELECT id, name FROM branch WHERE deleted_at IS NULL ORDER BY name')).rows;
}

export async function listCategoriesFlat(ctx: ServiceCtx): Promise<{ id: string; name: string }[]> {
  guard(ctx, 'inventory.view', 'inventory');
  return (await ctx.db.query('SELECT id, name FROM category WHERE deleted_at IS NULL ORDER BY name')).rows;
}

export async function listStocktakes(ctx: ServiceCtx) {
  guard(ctx, 'inventory.stocktake', 'inventory.stocktake');
  return (await ctx.db.query(
    `SELECT s.id, s.name, s.status, s.created_at, b.name AS branch_name, (SELECT count(*)::int FROM stocktake_scan x WHERE x.stocktake_id = s.id) AS scans
     FROM stocktake s LEFT JOIN branch b ON b.id = s.branch_id ORDER BY s.created_at DESC LIMIT 50`)).rows as
    { id: string; name: string; status: string; created_at: Date; branch_name: string | null; scans: number }[];
}

/**
 * Đổi trạng thái thiết bị do HỆ THỐNG điều khiển (giao/nhận, đặt lịch…): không kiểm tra quyền kho của người thao tác
 * vì nhân viên quầy giao nhận không có quyền quản lý kho. Vẫn tuân thủ máy trạng thái và ghi nhật ký.
 */
export async function setUnitStatus(ctx: ServiceCtx, unitId: string, to: UnitStatus, reason: string): Promise<void> {
  const u = (await ctx.db.query('SELECT status, barcode FROM equipment_unit WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [unitId])).rows[0];
  if (!u) throw new NotFoundError('thiết bị');
  assertTransition(u.status, to, { system: true });
  await ctx.db.query('UPDATE equipment_unit SET status=$2 WHERE id=$1', [unitId, to]);
  await ctx.db.query('INSERT INTO unit_status_log(tenant_id,unit_id,from_status,to_status,user_id,reason) VALUES ($1,$2,$3,$4,$5,$6)',
    [ctx.tenantId, unitId, u.status, to, ctx.userId, reason]);
}
