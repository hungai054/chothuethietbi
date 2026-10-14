import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant } from './ctx';
import {
  MemoryStorage, PlatformError, RETENTION_DAYS, exportTenantZip, listDeletedTenants, purgeTenant, resolveTenant, restoreTenant, softDeleteTenant, type Actor,
} from '../src';

let t: TestDb;
let actor: Actor;
beforeAll(async () => {
  t = await startTestDb(54333);
  await t.admin.query("INSERT INTO plan(code,name,price_month) VALUES ('p','Gói P',100000)");
  const u = await t.admin.query("INSERT INTO platform_user(email,password_hash,role) VALUES ('sa@x.vn','x','SUPER_ADMIN') RETURNING id");
  actor = { id: u.rows[0].id, email: 'sa@x.vn' };
}, 120_000);
afterAll(async () => { await t?.stop(); });

const slugOf = async (id: string) => (await t.admin.query('SELECT slug FROM tenant WHERE id=$1', [id])).rows[0].slug as string;

async function seedShop(storage: MemoryStorage) {
  const id = await mkTenant(t, 'p');
  const front = `tenants/${id}/id/front1.jpg`;
  const logo = `tenants/${id}/brand/logo.png`;
  await storage.put(front, new Uint8Array([1, 2, 3]), 'image/jpeg');
  await storage.put(logo, new Uint8Array([4, 5]), 'image/png');
  await t.admin.query("UPDATE tenant SET settings=$2 WHERE id=$1", [id, JSON.stringify({
    branding: { logoPath: logo }, notify: { smtp: { host: 'smtp.x', pass: 'sealed:abc', user: 'u' }, esms: { apiKey: 'SECRET-KEY-123' } }, finance: { store: { name: 'Shop X' } },
  })]);
  await t.admin.query("INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,'o@x.vn','Chủ','HASH-MAT-KHAU','OWNER')", [id]);
  const cust = (await t.admin.query("INSERT INTO customer(tenant_id,name,phone,email) VALUES ($1,'=CMD|calc','0900000001','a@x.vn') RETURNING id", [id])).rows[0].id;
  await t.admin.query(
    "INSERT INTO id_document(tenant_id,customer_id,type,number_enc,number_last4,number_hash,front_path,consent_at,consent_version) VALUES ($1,$2,'CCCD','ENC-SO-GIAY-TO','1234','BLIND-HASH',$3,now(),'v1')", [id, cust, front]);
  const model = (await t.admin.query("INSERT INTO equipment_model(tenant_id,name) VALUES ($1,'Máy A') RETURNING id", [id])).rows[0].id;
  await t.admin.query("INSERT INTO equipment_unit(tenant_id,model_id,barcode) VALUES ($1,$2,'A-000001'), ($1,$2,'A-000002')", [id, model]);
  return { id, front, logo };
}

const readZip = async (buf: Buffer) => JSZip.loadAsync(buf);

describe('xuất dữ liệu cửa hàng', () => {
  it('ZIP có JSON từng bảng, Excel, file đính kèm, README; không có mật khẩu/số giấy tờ/bí mật', async () => {
    const storage = new MemoryStorage();
    const { id, front, logo } = await seedShop(storage);
    const { zip, filename, stats } = await exportTenantZip(t.platform, id, { storage, actor });
    expect(filename).toMatch(/^rentpro-t[\w-]+-\d{4}-\d{2}-\d{2}\.zip$/);
    const z = await readZip(zip);
    const names = Object.keys(z.files);
    for (const n of ['README.txt', 'tong-hop.xlsx', 'data/_tenant.json', 'data/customer.json', 'data/equipment_unit.json', 'data/app_user.json', 'data/id_document.json']) expect(names).toContain(n);
    expect(names).toContain(`files/id/front1.jpg`);
    expect(names).toContain(`files/brand/logo.png`);
    expect(stats).toMatchObject({ files: 2, missingFiles: 0 });
    expect([...(await z.file('files/id/front1.jpg')!.async('uint8array'))]).toEqual([1, 2, 3]);
    const all = (await Promise.all(names.filter((n) => n.endsWith('.json') || n.endsWith('.txt')).map((n) => z.file(n)!.async('string')))).join('\n');
    for (const secret of ['HASH-MAT-KHAU', 'ENC-SO-GIAY-TO', 'BLIND-HASH', 'SECRET-KEY-123', 'sealed:abc']) expect(all).not.toContain(secret);
    expect(all).toContain('Shop X'); // cấu hình thường vẫn có
    const customers = JSON.parse((await z.file('data/customer.json')!.async('string')));
    expect(customers).toHaveLength(1);
    expect(front && logo).toBeTruthy();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await z.file('tong-hop.xlsx')!.async('nodebuffer')) as never);
    const sheet = wb.getWorksheet('Khách hàng')!;
    const nameCol = (sheet.getRow(1).values as string[]).indexOf('name');
    expect(sheet.getRow(2).getCell(nameCol).value).toBe("'=CMD|calc"); // chống công thức
    expect(wb.getWorksheet('Thiết bị')!.rowCount).toBe(3);
  });

  it('chỉ chứa dữ liệu của đúng cửa hàng, kể cả khi cửa hàng khác có dữ liệu tương tự', async () => {
    const s = new MemoryStorage();
    const a = await seedShop(s);
    const b = await seedShop(s);
    const z = await readZip((await exportTenantZip(t.platform, a.id, { storage: s })).zip);
    const text = (await Promise.all(Object.keys(z.files).filter((n) => n.endsWith('.json')).map((n) => z.file(n)!.async('string')))).join('');
    expect(text).not.toContain(b.id);
    expect(Object.keys(z.files).some((n) => n.includes(b.id))).toBe(false);
  });

  it('file thiếu trong kho được báo trong README; cửa hàng không tồn tại báo lỗi; ghi nhật ký', async () => {
    const s = new MemoryStorage();
    const { id, front } = await seedShop(s);
    s.files.delete(front);
    const r = await exportTenantZip(t.platform, id, { storage: s, actor });
    expect(r.stats.missingFiles).toBe(1);
    expect(await (await readZip(r.zip)).file('README.txt')!.async('string')).toContain('không đọc được');
    await expect(exportTenantZip(t.platform, '00000000-0000-0000-0000-0000000000aa')).rejects.toThrow(PlatformError);
    expect((await t.platform.query("SELECT 1 FROM platform_audit WHERE tenant_id=$1 AND action='tenant.export'", [id])).rowCount).toBe(1);
  });

  it('xuất được cả khi cửa hàng đang chỉ đọc/bị khóa (dữ liệu của khách luôn lấy ra được)', async () => {
    const id = await mkTenant(t, 'p', 'READ_ONLY');
    await t.admin.query("INSERT INTO customer(tenant_id,name,phone) VALUES ($1,'K','0911111111')", [id]);
    const r = await exportTenantZip(t.platform, id);
    expect(r.stats.rows).toBeGreaterThan(0);
  });
});

describe('xóa cửa hàng', () => {
  it('xóa mềm cần gõ đúng địa chỉ và lý do; sau đó không còn truy cập được; khôi phục về tạm khóa', async () => {
    const s = new MemoryStorage();
    const { id } = await seedShop(s);
    const slug = await slugOf(id);
    await expect(softDeleteTenant(t.platform, actor, id, { confirmSlug: 'sai-dia-chi', reason: 'Khách yêu cầu' })).rejects.toThrow(/không khớp/);
    await expect(softDeleteTenant(t.platform, actor, id, { confirmSlug: slug, reason: 'x' })).rejects.toThrow(/lý do/);
    expect((await t.admin.query('SELECT status FROM tenant WHERE id=$1', [id])).rows[0].status).toBe('ACTIVE');
    expect(await resolveTenant(t.app, slug)).not.toBeNull();

    const r = await softDeleteTenant(t.platform, actor, id, { confirmSlug: slug, reason: 'Khách yêu cầu xóa' });
    expect(r.purgeAfter.getTime()).toBeGreaterThan(Date.now() + (RETENTION_DAYS - 1) * 86_400_000);
    expect(await resolveTenant(t.app, slug)).toBeNull(); // địa chỉ ngừng hoạt động ngay
    expect((await t.admin.query('SELECT count(*)::int AS n FROM customer WHERE tenant_id=$1', [id])).rows[0].n).toBe(1); // dữ liệu vẫn còn
    await expect(softDeleteTenant(t.platform, actor, id, { confirmSlug: slug, reason: 'Khách yêu cầu xóa' })).rejects.toThrow(/Không tìm thấy/);
    expect((await listDeletedTenants(t.platform)).map((x) => x.id)).toContain(id);

    await restoreTenant(t.platform, actor, id);
    expect((await t.admin.query('SELECT status, deleted_at FROM tenant WHERE id=$1', [id])).rows[0]).toEqual({ status: 'SUSPENDED', deleted_at: null });
    expect(await resolveTenant(t.app, slug)).not.toBeNull();
    await expect(restoreTenant(t.platform, actor, id)).rejects.toThrow(/không ở trạng thái đã xóa/);
  });

  it('xóa hẳn: chỉ sau hạn giữ, cần xác nhận, xóa đúng cửa hàng đó và file đính kèm', async () => {
    const s = new MemoryStorage();
    const a = await seedShop(s);
    const b = await seedShop(s);
    const slugA = await slugOf(a.id);
    await expect(purgeTenant(t.platform, actor, a.id, { confirmSlug: slugA })).rejects.toThrow(/đã xóa mềm/);
    await softDeleteTenant(t.platform, actor, a.id, { confirmSlug: slugA, reason: 'Hết hợp đồng' });
    await expect(purgeTenant(t.platform, actor, a.id, { confirmSlug: slugA })).rejects.toThrow(/Chưa hết thời hạn/);
    const later = new Date(Date.now() + (RETENTION_DAYS + 1) * 86_400_000);
    await expect(purgeTenant(t.platform, actor, a.id, { confirmSlug: 'khac', storage: s }, later)).rejects.toThrow(/không khớp/);

    const r = await purgeTenant(t.platform, actor, a.id, { confirmSlug: slugA, storage: s }, later);
    expect(r.rows).toBeGreaterThanOrEqual(6);
    expect(r.files).toBe(2);
    expect((await t.admin.query('SELECT 1 FROM tenant WHERE id=$1', [a.id])).rowCount).toBe(0);
    for (const tbl of ['customer', 'id_document', 'equipment_model', 'equipment_unit', 'app_user', 'branch']) {
      expect((await t.admin.query(`SELECT 1 FROM ${tbl} WHERE tenant_id=$1`, [a.id])).rowCount).toBe(0);
    }
    expect(s.files.has(a.front)).toBe(false);
    expect(s.files.has(a.logo)).toBe(false);
    // cửa hàng B còn nguyên
    expect((await t.admin.query('SELECT count(*)::int AS n FROM customer WHERE tenant_id=$1', [b.id])).rows[0].n).toBe(1);
    expect(s.files.has(b.front)).toBe(true);
    expect((await t.platform.query("SELECT 1 FROM platform_audit WHERE action='tenant.purge'")).rowCount).toBeGreaterThan(0);
  });
});
