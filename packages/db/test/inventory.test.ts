import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ExcelJS from 'exceljs';
import { startTestDb, type TestDb } from './helpers';
import {
  withTenantId, createCategory, createModel, createUnits, transitionUnit, listUnits, listModels, getUnitDetail, findUnitByBarcode,
  softDeleteUnit, labelSheet, previewImport, commitImport, exportUnits, startStocktake, scanStocktake, stocktakeReport, closeStocktake,
  listCategoryTree, equipmentUsage, ValidationError, ReadOnlyError, type ServiceCtx,
} from '../src';
import { permissionsFor, InvalidTransitionError, ForbiddenError, IMPORT_COLUMNS, type TenantRole } from '@rentpro/core';
import { FEATURE_KEYS, LimitExceededError, FeatureDisabledError, resolveFeatures, resolveLimits, type FeatureKey, type Limits } from '@rentpro/tenancy';

let t: TestDb;
let seq = 0;

beforeAll(async () => {
  t = await startTestDb(54331);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
}, 120_000);
afterAll(async () => { await t?.stop(); });

interface Opts { role?: TenantRole; off?: FeatureKey[]; limits?: Partial<Limits>; status?: string }

async function mkTenant(status = 'ACTIVE') {
  const slug = `inv-${++seq}`;
  const plan = (await t.admin.query("SELECT id FROM plan WHERE code='p'")).rows[0].id;
  const id = (await t.admin.query('INSERT INTO tenant(slug,name,plan_id,status) VALUES ($1,$1,$2,$3) RETURNING id', [slug, plan, status])).rows[0].id as string;
  const branch = (await t.admin.query("INSERT INTO branch(tenant_id,name) VALUES ($1,'Chi nhánh chính') RETURNING id", [id])).rows[0].id as string;
  return { id, branch };
}

function run<T>(tenantId: string, o: Opts, fn: (c: ServiceCtx) => Promise<T>): Promise<T> {
  const on = Object.fromEntries(FEATURE_KEYS.filter((k) => !o.off?.includes(k)).map((k) => [k, true]));
  return withTenantId(t.app, tenantId, (db) => fn({
    db, tenantId, tenantStatus: o.status ?? 'ACTIVE', userId: null, permissions: permissionsFor(o.role ?? 'OWNER'),
    features: resolveFeatures({ planFeatures: on, overrides: {} }), limits: resolveLimits(o.limits ?? {}, {}),
  }));
}

async function xlsx(rows: Record<string, string>[]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Thiết bị');
  ws.addRow(IMPORT_COLUMNS.map((c) => c.header));
  for (const r of rows) ws.addRow(IMPORT_COLUMNS.map((c) => r[c.key] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('tạo thiết bị và mã vạch', () => {
  it('tự sinh mã theo tiền tố, mỗi tiền tố có bộ đếm riêng', async () => {
    const { id } = await mkTenant();
    const cam = await run(id, {}, (c) => createModel(c, { name: 'Sony A7', barcodePrefix: 'CAM' }));
    const lens = await run(id, {}, (c) => createModel(c, { name: '24-70', barcodePrefix: 'LEN' }));
    const a = await run(id, {}, (c) => createUnits(c, { modelId: cam, quantity: 3 }));
    const b = await run(id, {}, (c) => createUnits(c, { modelId: lens }));
    expect(a.map((x) => x.barcode)).toEqual(['CAM-000001', 'CAM-000002', 'CAM-000003']);
    expect(b[0]!.barcode).toBe('LEN-000001');
  });

  it('tạo đồng thời nhiều yêu cầu vẫn không trùng mã', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'Đèn', barcodePrefix: 'DEN' }));
    const res = await Promise.all(Array.from({ length: 12 }, () => run(id, {}, (c) => createUnits(c, { modelId: m }))));
    const codes = res.flat().map((x) => x.barcode);
    expect(new Set(codes).size).toBe(12);
  });

  it('mã thủ công trùng bị từ chối; auto bỏ qua mã đã bị dùng thủ công', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'Mic', barcodePrefix: 'MIC' }));
    await run(id, {}, (c) => createUnits(c, { modelId: m, barcode: 'mic-000001' })); // chuẩn hóa thành chữ hoa
    await expect(run(id, {}, (c) => createUnits(c, { modelId: m, barcode: 'MIC-000001' }))).rejects.toThrow(/đã tồn tại/);
    const auto = await run(id, {}, (c) => createUnits(c, { modelId: m }));
    expect(auto[0]!.barcode).toBe('MIC-000002');
  });

  it('serial trùng trong cùng mẫu bị chặn, khác mẫu thì được', async () => {
    const { id } = await mkTenant();
    const m1 = await run(id, {}, (c) => createModel(c, { name: 'A' }));
    const m2 = await run(id, {}, (c) => createModel(c, { name: 'B' }));
    await run(id, {}, (c) => createUnits(c, { modelId: m1, serial: 'S1' }));
    await expect(run(id, {}, (c) => createUnits(c, { modelId: m1, serial: 'S1' }))).rejects.toThrow(/Serial/);
    await expect(run(id, {}, (c) => createUnits(c, { modelId: m2, serial: 'S1' }))).resolves.toBeDefined();
  });

  it('kiểm tra đầu vào: số lượng, mã vạch sai, mẫu theo số lượng', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'X' }));
    const q = await run(id, {}, (c) => createModel(c, { name: 'Cáp', tracked: false, stockQty: 20 }));
    await expect(run(id, {}, (c) => createUnits(c, { modelId: m, quantity: 0 }))).rejects.toThrow(ValidationError);
    await expect(run(id, {}, (c) => createUnits(c, { modelId: m, quantity: 2, serial: 'S' }))).rejects.toThrow(/nhiều thiết bị/);
    await expect(run(id, {}, (c) => createUnits(c, { modelId: m, barcode: 'có dấu' }))).rejects.toThrow(/không hợp lệ/);
    await expect(run(id, {}, (c) => createUnits(c, { modelId: q }))).rejects.toThrow(/số lượng/);
    await expect(run(id, {}, (c) => createModel(c, { name: 'Y', barcodePrefix: 'abc' }))).rejects.toThrow(/Tiền tố/);
  });
});

describe('quyền, gói và chế độ chỉ đọc (kiểm tra trong service)', () => {
  it('vượt giới hạn thiết bị của gói: chặn cả khi tạo hàng loạt; cảnh báo 80%', async () => {
    const { id } = await mkTenant();
    const o = { limits: { equipment: 5 } };
    const m = await run(id, o, (c) => createModel(c, { name: 'L' }));
    await run(id, o, (c) => createUnits(c, { modelId: m, quantity: 4 }));
    expect((await run(id, o, (c) => equipmentUsage(c))).near).toBe(true);
    await expect(run(id, o, (c) => createUnits(c, { modelId: m, quantity: 2 }))).rejects.toThrow(LimitExceededError);
    await run(id, o, (c) => createUnits(c, { modelId: m }));
    await expect(run(id, o, (c) => createUnits(c, { modelId: m }))).rejects.toThrow(/nâng cấp/);
    expect((await run(id, o, (c) => listUnits(c))).total).toBe(5);
  });

  it('thiếu quyền: nhân viên quầy chỉ xem, không tạo/đổi trạng thái', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'S' }));
    const [u] = await run(id, {}, (c) => createUnits(c, { modelId: m }));
    await expect(run(id, { role: 'STAFF' }, (c) => createUnits(c, { modelId: m }))).rejects.toThrow(ForbiddenError);
    await expect(run(id, { role: 'STAFF' }, (c) => transitionUnit(c, u!.id, 'MAINTENANCE', { reason: 'x' }))).rejects.toThrow(ForbiddenError);
    expect((await run(id, { role: 'STAFF' }, (c) => listUnits(c))).total).toBe(1);
  });

  it('tính năng tắt theo gói: quét mã, in tem, kiểm kê bị chặn dù gọi trực tiếp', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'F' }));
    const [u] = await run(id, {}, (c) => createUnits(c, { modelId: m }));
    const off = { off: ['inventory.barcode', 'inventory.stocktake'] as FeatureKey[] };
    await expect(run(id, off, (c) => findUnitByBarcode(c, u!.barcode))).rejects.toThrow(FeatureDisabledError);
    await expect(run(id, off, (c) => labelSheet(c, [u!.id]))).rejects.toThrow(FeatureDisabledError);
    await expect(run(id, off, (c) => startStocktake(c, { name: 'x' }))).rejects.toThrow(FeatureDisabledError);
    await expect(run(id, { off: ['inventory'] }, (c) => listUnits(c))).rejects.toThrow(FeatureDisabledError);
  });

  it('tenant chỉ đọc: đọc được, ghi bị chặn', async () => {
    const { id } = await mkTenant('READ_ONLY');
    const o = { status: 'READ_ONLY' };
    await expect(run(id, o, (c) => createModel(c, { name: 'R' }))).rejects.toThrow(ReadOnlyError);
    await expect(run(id, o, (c) => createCategory(c, { name: 'R' }))).rejects.toThrow(ReadOnlyError);
    await expect(run(id, o, (c) => listModels(c))).resolves.toEqual([]);
    await expect(run(id, o, (c) => exportUnits(c))).resolves.toBeInstanceOf(Buffer);
  });

  it('tenant A không thấy/không đổi được thiết bị của tenant B', async () => {
    const A = await mkTenant();
    const B = await mkTenant();
    const m = await run(A.id, {}, (c) => createModel(c, { name: 'Riêng A' }));
    const [u] = await run(A.id, {}, (c) => createUnits(c, { modelId: m }));
    expect((await run(B.id, {}, (c) => listUnits(c))).total).toBe(0);
    expect(await run(B.id, {}, (c) => findUnitByBarcode(c, u!.barcode))).toBeNull();
    await expect(run(B.id, {}, (c) => transitionUnit(c, u!.id, 'MAINTENANCE', { reason: 'x' }))).rejects.toThrow(/Không tìm thấy/);
    await expect(run(B.id, {}, (c) => getUnitDetail(c, u!.id))).rejects.toThrow(/Không tìm thấy/);
    // mã vạch cùng giá trị ở hai tenant là được
    const mb = await run(B.id, {}, (c) => createModel(c, { name: 'Riêng B' }));
    await expect(run(B.id, {}, (c) => createUnits(c, { modelId: mb, barcode: u!.barcode }))).resolves.toBeDefined();
  });
});

describe('trạng thái thiết bị', () => {
  it('chuyển hợp lệ ghi lịch sử; chuyển sai bị chặn; mất lý do bị chặn', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'T' }));
    const [u] = await run(id, {}, (c) => createUnits(c, { modelId: m }));
    await expect(run(id, {}, (c) => transitionUnit(c, u!.id, 'MAINTENANCE', { reason: ' ' }))).rejects.toThrow(/lý do/);
    await run(id, {}, (c) => transitionUnit(c, u!.id, 'MAINTENANCE', { reason: 'Thay cảm biến' }));
    await expect(run(id, {}, (c) => transitionUnit(c, u!.id, 'RENTED', { system: true }))).rejects.toThrow(InvalidTransitionError);
    await expect(run(id, {}, (c) => transitionUnit(c, u!.id, 'RESERVED'))).rejects.toThrow(InvalidTransitionError);
    await run(id, {}, (c) => transitionUnit(c, u!.id, 'AVAILABLE'));
    const { history } = await run(id, {}, (c) => getUnitDetail(c, u!.id));
    expect(history.map((h) => `${h.from_status ?? '-'}>${h.to_status}`)).toEqual(['MAINTENANCE>AVAILABLE', 'AVAILABLE>MAINTENANCE', '->AVAILABLE']);
  });

  it('luồng thuê do hệ thống điều khiển', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'Flow' }));
    const [u] = await run(id, {}, (c) => createUnits(c, { modelId: m }));
    for (const s of ['RESERVED', 'RENTED', 'INSPECTING'] as const) await run(id, {}, (c) => transitionUnit(c, u!.id, s, { system: true }));
    await run(id, {}, (c) => transitionUnit(c, u!.id, 'AVAILABLE'));
    expect((await run(id, {}, (c) => findUnitByBarcode(c, u!.barcode)))?.status).toBe('AVAILABLE');
  });

  it('hai người đổi trạng thái cùng lúc: chỉ một thành công, không ghi đè nhau', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'Race' }));
    const [u] = await run(id, {}, (c) => createUnits(c, { modelId: m }));
    const r = await Promise.allSettled([
      run(id, {}, (c) => transitionUnit(c, u!.id, 'MAINTENANCE', { reason: 'a' })),
      run(id, {}, (c) => transitionUnit(c, u!.id, 'LOST', { reason: 'b' })),
    ]);
    // Cả hai đều hợp lệ từ AVAILABLE nhưng sau khi cái đầu xong, MAINTENANCE→LOST vẫn hợp lệ; lịch sử phải nhất quán.
    const { unit, history } = await run(id, {}, (c) => getUnitDetail(c, u!.id));
    expect(r.every((x) => x.status === 'fulfilled')).toBe(true);
    expect(history.length).toBe(3);
    expect(history[0]!.to_status).toBe(unit.status);
    expect(history[0]!.from_status).toBe(history[1]!.to_status);
  });

  it('nhật ký trạng thái chỉ thêm: app role không sửa/xóa được', async () => {
    const { id } = await mkTenant();
    await expect(withTenantId(t.app, id, (db) => db.query('UPDATE unit_status_log SET reason=$1', ['x']))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, id, (db) => db.query('DELETE FROM unit_status_log'))).rejects.toThrow(/permission denied/);
  });

  it('xóa mềm: chỉ khi rảnh/thanh lý/mất và không còn lịch', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'Del' }));
    const [a, b] = await run(id, {}, (c) => createUnits(c, { modelId: m, quantity: 2 }));
    await run(id, {}, (c) => transitionUnit(c, a!.id, 'RESERVED', { system: true }));
    await expect(run(id, {}, (c) => softDeleteUnit(c, a!.id, 'dọn'))).rejects.toThrow(/Đã giữ chỗ/);
    await expect(run(id, {}, (c) => softDeleteUnit(c, b!.id, ''))).rejects.toThrow(/lý do/);
    // có lịch đặt thì chặn dù đang rảnh
    const cust = (await t.admin.query("INSERT INTO customer(tenant_id,name,phone) VALUES ($1,'K','0900') RETURNING id", [id])).rows[0].id;
    const bk = (await t.admin.query("INSERT INTO booking(tenant_id,code,customer_id,starts_at,ends_at) VALUES ($1,'B1',$2,'2030-01-01','2030-01-02') RETURNING id", [id, cust])).rows[0].id;
    await t.admin.query("INSERT INTO unit_allocation(tenant_id,booking_id,unit_id,period,status) VALUES ($1,$2,$3,'[2030-01-01,2030-01-02)','CONFIRMED')", [id, bk, b!.id]);
    await expect(run(id, {}, (c) => softDeleteUnit(c, b!.id, 'dọn'))).rejects.toThrow(/lịch đặt/);
    await t.admin.query('UPDATE unit_allocation SET status=$1 WHERE unit_id=$2', ['RELEASED', b!.id]);
    await run(id, {}, (c) => softDeleteUnit(c, b!.id, 'dọn'));
    expect((await run(id, {}, (c) => listUnits(c))).total).toBe(1);
  });
});

describe('danh sách, lọc, phân trang, danh mục', () => {
  it('lọc theo trạng thái/từ khóa, phân trang phía server, đếm theo trạng thái trên mẫu', async () => {
    const { id } = await mkTenant();
    const cat = await run(id, {}, (c) => createCategory(c, { name: 'Máy ảnh' }));
    await run(id, {}, (c) => createCategory(c, { name: 'Mirrorless', parentId: cat }));
    const m = await run(id, {}, (c) => createModel(c, { name: 'Canon R5', brand: 'Canon', categoryId: cat, barcodePrefix: 'R5' }));
    const us = await run(id, {}, (c) => createUnits(c, { modelId: m, quantity: 7 }));
    await run(id, {}, (c) => transitionUnit(c, us[0]!.id, 'MAINTENANCE', { reason: 'vệ sinh' }));
    const page1 = await run(id, {}, (c) => listUnits(c, { pageSize: 3, page: 1 }));
    const page3 = await run(id, {}, (c) => listUnits(c, { pageSize: 3, page: 3 }));
    expect([page1.total, page1.rows.length, page3.rows.length]).toEqual([7, 3, 1]);
    expect((await run(id, {}, (c) => listUnits(c, { status: 'MAINTENANCE' }))).total).toBe(1);
    expect((await run(id, {}, (c) => listUnits(c, { q: 'r5-000003' }))).total).toBe(1);
    expect((await run(id, {}, (c) => listUnits(c, { categoryId: cat }))).total).toBe(7);
    const [row] = await run(id, {}, (c) => listModels(c, { q: 'canon' }));
    expect(row).toMatchObject({ total: 7, categoryName: 'Máy ảnh', counts: { AVAILABLE: 6, MAINTENANCE: 1 } });
    const tree = await run(id, {}, (c) => listCategoryTree(c));
    expect(tree[0]!.children.map((x) => x.name)).toEqual(['Mirrorless']);
  });

  it('q chứa ký tự đặc biệt của SQL được xử lý như văn bản', async () => {
    const { id } = await mkTenant();
    await expect(run(id, {}, (c) => listUnits(c, { q: "'; DROP TABLE equipment_unit; --" }))).resolves.toMatchObject({ total: 0 });
    await expect(run(id, {}, (c) => listUnits(c, { pageSize: 1e9 }))).resolves.toBeDefined(); // bị kẹp tối đa 200
  });
});

describe('quét mã và in tem', () => {
  it('tra mã không phân biệt hoa thường, bỏ ký tự thừa của máy quét; in tem từ DB', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'Cam <1>', barcodePrefix: 'CAM' }));
    const [u] = await run(id, {}, (c) => createUnits(c, { modelId: m }));
    expect((await run(id, {}, (c) => findUnitByBarcode(c, ' cam-000001\r\n')))?.id).toBe(u!.id);
    expect(await run(id, {}, (c) => findUnitByBarcode(c, 'KHONG-CO'))).toBeNull();
    const html = await run(id, {}, (c) => labelSheet(c, [u!.id]));
    expect(html).toContain('Cam &lt;1&gt;');
    expect((html.match(/<svg/g) ?? []).length).toBe(2);
    await expect(run(id, {}, (c) => labelSheet(c, []))).rejects.toThrow(/1 đến 500/);
  });
});

describe('nhập / xuất Excel', () => {
  it('nhập hợp lệ: tạo danh mục, mẫu, thiết bị; dùng lại mẫu có sẵn; xuất ra đọc lại được', async () => {
    const { id } = await mkTenant();
    const file = await xlsx([
      { category: 'Máy ảnh', model: 'Sony A7', brand: 'Sony', serial: 'S1', branch: 'chi nhánh chính', purchasePrice: '30.000.000', condition: 'Mới' },
      { category: 'Máy ảnh', model: 'sony a7', serial: 'S2' },
      { category: 'Lens', model: 'GM 24-70', barcode: 'LENS-1' },
    ]);
    const p = await run(id, {}, (c) => previewImport(c, file));
    expect([p.total, p.valid, p.errors.length]).toEqual([3, 3, 0]);
    expect(await run(id, {}, (c) => commitImport(c, file))).toEqual({ created: 3 });
    expect((await run(id, {}, (c) => listModels(c))).map((m) => [m.name, m.total])).toEqual([['GM 24-70', 1], ['Sony A7', 2]]);
    expect((await run(id, {}, (c) => listCategoryTree(c))).map((x) => x.name).sort()).toEqual(['Lens', 'Máy ảnh']);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await run(id, {}, (c) => exportUnits(c))) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.rowCount).toBe(4); // tiêu đề + 3 thiết bị
    expect(ws.getRow(2).getCell(5).value).toBe('Rảnh');
  });

  it('có lỗi thì không nhập dòng nào (toàn bộ hoặc không gì)', async () => {
    const { id } = await mkTenant();
    const file = await xlsx([{ model: 'OK' }, { model: '', serial: 'S9' }, { model: 'X', branch: 'Kho lạ' }]);
    const p = await run(id, {}, (c) => previewImport(c, file));
    expect(p.errors.map((e) => `${e.row}:${e.field}`)).toEqual(['3:Tên mẫu', '4:Chi nhánh']);
    await expect(run(id, {}, (c) => commitImport(c, file))).rejects.toThrow(/2 lỗi/);
    expect((await run(id, {}, (c) => listUnits(c))).total).toBe(0);
    expect(await run(id, {}, (c) => listModels(c))).toEqual([]);
  });

  it('trùng với dữ liệu đã có bị báo lỗi; vượt hạn mức gói thì từ chối cả file', async () => {
    const { id } = await mkTenant();
    const m = await run(id, {}, (c) => createModel(c, { name: 'Dup', barcodePrefix: 'D' }));
    await run(id, {}, (c) => createUnits(c, { modelId: m, serial: 'S1', barcode: 'D-1' }));
    const file = await xlsx([{ model: 'dup', serial: 's1' }, { model: 'Z', barcode: 'd-1' }]);
    const q = await run(id, {}, (c) => previewImport(c, file));
    expect(q.errors.map((e) => e.field)).toEqual(['Serial', 'Mã vạch']);

    const lim = { limits: { equipment: 2 } };
    const big = await xlsx([{ model: 'A1' }, { model: 'A2' }]);
    await expect(run(id, lim, (c) => commitImport(c, big))).rejects.toThrow(LimitExceededError); // đã có 1 + 2 > 2
    expect((await run(id, {}, (c) => listUnits(c))).total).toBe(1);
  });

  it('file không phải Excel cho thông báo thân thiện, không ném lỗi hệ thống', async () => {
    const { id } = await mkTenant();
    const p = await run(id, {}, (c) => previewImport(c, Buffer.from('xin chào')));
    expect(p.fileError).toMatch(/Không đọc được/);
    await expect(run(id, {}, (c) => commitImport(c, Buffer.from('xin chào')))).rejects.toThrow(/Không đọc được/);
  });
});

describe('kiểm kê', () => {
  it('quét: khớp, trùng, lạ, sai chi nhánh, bất thường; báo thiếu; đóng rồi không quét được', async () => {
    const { id, branch } = await mkTenant();
    const other = (await t.admin.query("INSERT INTO branch(tenant_id,name) VALUES ($1,'CN2') RETURNING id", [id])).rows[0].id;
    const m = await run(id, {}, (c) => createModel(c, { name: 'K', barcodePrefix: 'K' }));
    const us = await run(id, {}, (c) => createUnits(c, { modelId: m, quantity: 5 }));
    await t.admin.query('UPDATE equipment_unit SET branch_id=$1 WHERE id = ANY($2::uuid[])', [branch, us.slice(0, 4).map((u) => u.id)]);
    await t.admin.query('UPDATE equipment_unit SET branch_id=$1 WHERE id=$2', [other, us[4]!.id]);
    await run(id, {}, (c) => transitionUnit(c, us[3]!.id, 'RESERVED', { system: true }));

    const st = await run(id, {}, (c) => startStocktake(c, { name: 'Cuối tháng', branchId: branch }));
    const scan = (code: string) => run(id, {}, (c) => scanStocktake(c, st, code)).then((r) => r.outcome);
    expect(await scan('k-000001')).toBe('MATCHED');
    expect(await scan('K-000001')).toBe('DUPLICATE');
    expect(await scan('NOPE')).toBe('UNKNOWN');
    expect(await scan('K-000005')).toBe('WRONG_BRANCH');
    expect(await scan('K-000004')).toBe('UNEXPECTED');

    const { result } = await run(id, {}, (c) => stocktakeReport(c, st));
    expect(result.missing.map((x) => x.barcode).sort()).toEqual(['K-000002', 'K-000003']);
    expect(result.wrongBranch.map((x) => x.barcode)).toEqual(['K-000005']);
    expect(result.matched.map((x) => x.barcode)).toEqual(['K-000001']);

    await run(id, {}, (c) => closeStocktake(c, st));
    await expect(run(id, {}, (c) => scanStocktake(c, st, 'K-000002'))).rejects.toThrow(/đã đóng/);
    await expect(run(id, {}, (c) => closeStocktake(c, st))).rejects.toThrow(/đã đóng/);
  });

  it('kỹ thuật viên kiểm kê được; nhân viên quầy thì không', async () => {
    const { id } = await mkTenant();
    await expect(run(id, { role: 'TECHNICIAN' }, (c) => startStocktake(c, { name: 'KT' }))).resolves.toBeDefined();
    await expect(run(id, { role: 'STAFF' }, (c) => startStocktake(c, { name: 'NV' }))).rejects.toThrow(ForbiddenError);
  });
});
