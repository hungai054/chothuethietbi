import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs, type Opts } from './ctx';
import {
  PlatformError, applyExtensionMigrations, confirmBooking, createBooking, createContract, createCustomer, createFieldDef, createModel, createUnits, deliverBooking, dispatchQueued, ensureDefaultPriceList,
  getContract, listExtensionErrors, listReports, listTenantExtensions, listTenantExtensionsAdmin, receiveBooking, runExtensionJobs, runReport, setRule, setTenantExtension, suggestBookingDeposit,
  updateDocTemplates, updateFinanceSettings, validateReadSql, withTenantId, type NotifyDeps,
} from '../src';
import { ForbiddenError } from '@rentpro/core';
import { ConsoleProvider } from '@rentpro/notifications';
import { ExtensionVeto, clearRegistry, defineExtension, registerExtension, type ExtensionDefinition } from '@rentpro/extension-sdk';
import { FEATURE_KEYS } from '@rentpro/tenancy';

let t: TestDb;
const calls: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const actor = { id: '00000000-0000-0000-0000-000000000000', email: 'admin@test.local' };

const modeSchema = z.object({ uplift: z.number().min(0).max(100).default(20), mode: z.enum(['ok', 'crash', 'slow', 'veto']).default('ok') }).strict();

const extA: ExtensionDefinition = defineExtension({
  manifest: {
    code: 'ext-a', name: 'Extension A', version: '1.0.0', sdk: '^1.0', description: 'Thử nghiệm',
    hooks: ['pricing.adjust', 'deposit.suggest', 'booking.beforeCreate', 'booking.afterConfirm', 'booking.afterReturn', 'notification.beforeSend', 'contract.extraVariables'],
  },
  configSchema: modeSchema,
  hooks: {
    'pricing.adjust': (ctx, q) => {
      if (ctx.config.mode === 'crash') throw new Error('lỗi giá');
      return [{ label: 'Phụ thu cuối tuần', amount: Math.round((q.subtotal * (ctx.config.uplift as number)) / 100), source: 'extension' }];
    },
    'deposit.suggest': (ctx, c) => { if (ctx.config.mode === 'crash') throw new Error('lỗi cọc'); return c.suggested + 50_000; },
    'booking.beforeCreate': async (ctx) => {
      if (ctx.config.mode === 'veto') throw new ExtensionVeto('Khách này cần đặt cọc trước.');
      if (ctx.config.mode === 'crash') throw new Error('hỏng beforeCreate');
      if (ctx.config.mode === 'slow') await sleep(2600);
    },
    'booking.afterConfirm': (ctx, b) => { calls.push(`confirm:${b.status}:${ctx.tenantId.slice(0, 4)}`); if (ctx.config.mode === 'crash') throw new Error('hỏng afterConfirm'); },
    'booking.afterReturn': (_c, b) => { calls.push(`return:${b.status}:${b.late}`); },
    'notification.beforeSend': (_c, m) => {
      if (m.body.includes('CHAN')) return null;
      if (m.body.includes('DOINGUOI')) return { ...m, to: 'x@x.vn' };
      if (m.body.includes('DOI')) return { ...m, body: `${m.body} [ext]` };
      return m;
    },
    'contract.extraVariables': (ctx) => ({ ma_vip: `VIP-${ctx.tenantId.slice(0, 4)}`, 'Ten Sai': 'x', dai: 'y'.repeat(600) }),
  },
  reports: [{
    key: 'tong-don', title: 'Tổng đơn', description: 'Đếm đơn', permission: 'reports.finance',
    run: async (ctx) => {
      if (ctx.config.mode === 'crash') throw new Error('hỏng báo cáo');
      const rows = await ctx.read.query<{ n: number }>('SELECT count(*)::int AS n FROM booking');
      return { key: 'x', title: 'Tổng đơn', period: '', cards: [{ label: 'Số đơn', value: rows[0]!.n, type: 'int' }], sections: [] };
    },
  }],
  pages: [{ path: 'tong-quan', title: 'Tổng quan riêng', run: undefined as never, render: async () => ({ key: 'p', title: 'T', period: '', sections: [] }) }] as never,
  jobs: [
    { name: 'dong-bo', schedule: { everyMinutes: 5 }, handler: async (ctx) => { const n = (await ctx.store.get<number>('lan')) ?? 0; await ctx.store.set('lan', n + 1); } },
    { name: 'hong', schedule: { dailyAt: '00:00' }, handler: async (ctx) => { await ctx.store.set('truoc-khi-hong', 1); throw new Error('tác vụ hỏng'); } },
  ],
});

const extReq: ExtensionDefinition = defineExtension({
  manifest: { code: 'ext-req', name: 'Extension bắt buộc', version: '2.1.0', sdk: '^1.0', hooks: ['booking.beforeCreate'], required: ['booking.beforeCreate'] },
  configSchema: z.object({ fail: z.boolean().default(false) }).strict(),
  hooks: { 'booking.beforeCreate': (ctx) => { if (ctx.config.fail) throw new Error('hỏng bắt buộc'); } },
});

const extDb: ExtensionDefinition = defineExtension({
  manifest: {
    code: 'dbx', name: 'Có bảng riêng', version: '1.0.0', sdk: '^1.0', hooks: [],
    migrations: [{ id: '001', sql: `CREATE TABLE ext_dbx_note (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, body text);
      ALTER TABLE ext_dbx_note ENABLE ROW LEVEL SECURITY; ALTER TABLE ext_dbx_note FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ext_dbx_note USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())` }],
  },
});

beforeAll(async () => {
  clearRegistry();
  for (const d of [extA, extReq, extDb]) registerExtension(d);
  t = await startTestDb(54341);
  await t.admin.query("INSERT INTO plan(code,name,features,limits) VALUES ('full','Full',$1,'{}')", [JSON.stringify(Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])))]);
  await t.admin.query("INSERT INTO plan(code,name,features,limits) VALUES ('basic','Basic',$1,'{}')", [JSON.stringify({ booking: true })]);
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const D = 86_400_000;
const enable = (A: string, code: string, config: unknown = {}) => setTenantExtension(t.platform, actor, A, code, { enabled: true, config });

async function shop(enableA: Record<string, unknown> | null = {}) {
  const A = await mkTenant(t, 'full');
  const cam = await as(A, {}, (c) => createModel(c, { name: 'Sony A7', barcodePrefix: 'CAM' }));
  const units = await as(A, {}, (c) => createUnits(c, { modelId: cam, quantity: 2 }));
  const list = await as(A, {}, (c) => ensureDefaultPriceList(c));
  await as(A, {}, (c) => setRule(c, list, cam, { hour: 100_000, day: 500_000, week: 2_500_000, month: null, minHours: 0 }));
  const cust = await as(A, {}, (c) => createCustomer(c, { name: 'Nguyễn Văn An', phone: '0901234567' }));
  await as(A, {}, (c) => updateFinanceSettings(c, { handover: { requireContract: false, requireDeposit: false } }));
  if (enableA) await enable(A, 'ext-a', enableA);
  return { A, cam, units, cust };
}
type Shop = Awaited<ReturnType<typeof shop>>;
let slot = 0;
const mk = (s: Shop, status: 'QUOTE' | 'HOLD' | 'CONFIRMED' = 'CONFIRMED', o: Opts = {}) => {
  const start = new Date(Date.now() + (5 + ++slot * 3) * D);
  return as(s.A, o, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1 }], start, end: new Date(start.getTime() + D), status }));
};
const errors = async (A: string) => (await t.admin.query('SELECT extension_code, hook, message FROM extension_error_log WHERE tenant_id=$1 ORDER BY id', [A])).rows;

describe('bật/tắt extension theo cửa hàng (cổng quản trị)', () => {
  it('chỉ extension đã cài, cấu hình hợp lệ, gói có tính năng; ghi audit; cửa hàng không tự bật được', async () => {
    const A = await mkTenant(t, 'full');
    const basic = await mkTenant(t, 'basic');
    await expect(setTenantExtension(t.platform, actor, A, 'khong-co', { enabled: true })).rejects.toThrow(/chưa được cài/);
    await expect(setTenantExtension(t.platform, actor, A, 'ext-a', { enabled: true, config: { uplift: 500 } })).rejects.toThrow(/Cấu hình không hợp lệ: uplift/);
    await expect(setTenantExtension(t.platform, actor, A, 'ext-a', { enabled: true, config: { la: 1 } })).rejects.toThrow(PlatformError);
    await expect(setTenantExtension(t.platform, actor, basic, 'ext-a', { enabled: true })).rejects.toThrow(/chưa có tính năng extension/);
    await expect(setTenantExtension(t.platform, actor, '00000000-0000-0000-0000-000000000001', 'ext-a', { enabled: true })).rejects.toThrow(/Không tìm thấy khách hàng/);
    await enable(A, 'ext-a', { uplift: 30 });
    const row = (await listTenantExtensionsAdmin(t.platform, A)).find((r) => r.code === 'ext-a')!;
    expect(row).toMatchObject({ enabled: true, config: { uplift: 30, mode: 'ok' }, enabledBy: 'admin@test.local', compatible: null, installed: true });
    expect((await listTenantExtensionsAdmin(t.platform, A)).map((r) => r.code).sort()).toEqual(['dbx', 'ext-a', 'ext-req']);
    expect((await t.admin.query("SELECT 1 FROM platform_audit WHERE tenant_id=$1 AND action='tenant.extension.enable'", [A])).rowCount).toBe(1);
    await setTenantExtension(t.platform, actor, A, 'ext-a', { enabled: false });
    expect((await listTenantExtensionsAdmin(t.platform, A)).find((r) => r.code === 'ext-a')).toMatchObject({ enabled: false, enabledAt: null });
    // role ứng dụng không ghi được tenant_extension
    await expect(withTenantId(t.app, A, (db) => db.query("UPDATE tenant_extension SET enabled=true WHERE tenant_id=$1", [A]))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, A, (db) => db.query("INSERT INTO tenant_extension(tenant_id, extension_code) VALUES ($1,'ext-req')", [A]))).rejects.toThrow(/permission denied/);
  });

  it('nạp extension hiệu lực: tắt, hạ gói, cấu hình hỏng, chưa cài; mỗi cửa hàng một bộ', async () => {
    const s = await shop();
    const B = await shop(null);
    expect((await as(s.A, {}, (c) => listTenantExtensions(c)))[0]).toMatchObject({ code: 'ext-a', enabled: true, hooks: expect.arrayContaining(['pricing.adjust']), reports: 1, pages: 1, jobs: 2 });
    expect(await as(B.A, {}, (c) => listTenantExtensions(c))).toEqual([]);
    expect((await as(s.A, { off: ['extensions'] }, (c) => listTenantExtensions(c)))[0]).toMatchObject({ enabled: false, skippedReason: 'Gói hiện tại không có tính năng extension.' });
    await t.admin.query("UPDATE tenant_extension SET config='{\"uplift\": 999}' WHERE tenant_id=$1", [s.A]);
    expect((await as(s.A, {}, (c) => listTenantExtensions(c)))[0]).toMatchObject({ enabled: false, skippedReason: expect.stringContaining('Cấu hình không hợp lệ') });
    await t.admin.query("UPDATE tenant_extension SET config='{}' WHERE tenant_id=$1", [s.A]);
    await t.admin.query("INSERT INTO tenant_extension(tenant_id, extension_code, enabled) VALUES ($1,'khong-cai-dat',true)", [s.A]);
    const list = await as(s.A, {}, (c) => listTenantExtensions(c));
    expect(list.find((x) => x.code === 'khong-cai-dat')).toMatchObject({ enabled: false, skippedReason: expect.stringContaining('chưa được cài') });
    expect(list.find((x) => x.code === 'ext-a')!.enabled).toBe(true); // một extension hỏng không kéo theo extension khác
  });
});

describe('móc giá và cọc (đồng bộ)', () => {
  it('extension thêm dòng điều chỉnh giá, tính vào tổng đơn; cửa hàng khác không bị ảnh hưởng', async () => {
    const s = await shop({ uplift: 20 });
    const B = await shop(null);
    const a = await mk(s, 'QUOTE');
    const q = (await t.admin.query('SELECT total, quote FROM booking WHERE id=$1', [a.id])).rows[0];
    expect(Number(q.total)).toBe(600_000);
    expect(q.quote.adjustments).toEqual([{ label: 'Phụ thu cuối tuần', amount: 100_000, source: 'extension' }]);
    const b = await mk(B, 'QUOTE');
    expect(Number((await t.admin.query('SELECT total FROM booking WHERE id=$1', [b.id])).rows[0].total)).toBe(500_000);
  });
  it('móc giá/cọc bị lỗi: bỏ qua, báo cảnh báo, ghi nhật ký lỗi; đơn vẫn tạo được', async () => {
    const s = await shop({ mode: 'crash' });
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'FIXED', value: 1_000_000 } }));
    const a = await mk(s, 'QUOTE');
    expect(Number((await t.admin.query('SELECT total FROM booking WHERE id=$1', [a.id])).rows[0].total)).toBe(500_000);
    expect((await as(s.A, {}, (c) => suggestBookingDeposit(c, a.id))).amount).toBe(1_000_000); // dùng mức gốc khi móc lỗi
    const errs = await errors(s.A);
    expect(errs.map((e) => e.hook)).toEqual(expect.arrayContaining(['pricing.adjust']));
    expect(errs.find((e) => e.hook === 'pricing.adjust')).toMatchObject({ extension_code: 'ext-a', message: 'lỗi giá' });
  });
  it('móc cọc đổi mức cọc gợi ý', async () => {
    const s = await shop({});
    await as(s.A, {}, (c) => updateFinanceSettings(c, { deposit: { mode: 'FIXED', value: 1_000_000 } }));
    const a = await mk(s, 'QUOTE');
    expect((await as(s.A, {}, (c) => suggestBookingDeposit(c, a.id))).amount).toBe(1_050_000);
  });
});

describe('móc bất đồng bộ', () => {
  it('beforeCreate: từ chối có chủ đích hiện lý do cho người dùng, không tạo đơn; lỗi thường bị cô lập; quá thời gian bị ngắt', async () => {
    const s = await shop({ mode: 'veto' });
    const count = async () => (await t.admin.query('SELECT count(*)::int n FROM booking WHERE tenant_id=$1', [s.A])).rows[0].n as number;
    await expect(mk(s)).rejects.toThrow('Extension A: Khách này cần đặt cọc trước.');
    expect(await count()).toBe(0);
    await enable(s.A, 'ext-a', { mode: 'crash' });
    await expect(mk(s, 'QUOTE')).resolves.toBeDefined(); // không bắt buộc: lỗi bị bỏ qua
    expect((await errors(s.A)).some((e) => e.hook === 'booking.beforeCreate' && e.message === 'hỏng beforeCreate')).toBe(true);
    await enable(s.A, 'ext-a', { mode: 'slow' });
    const t0 = Date.now();
    await expect(mk(s, 'QUOTE')).resolves.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(2500); // bị ngắt ở ~2 giây thay vì chờ 2,6 giây
    expect((await errors(s.A)).some((e) => /Quá thời gian chờ/.test(e.message))).toBe(true);
  });
  it('móc bắt buộc bị lỗi thì thao tác thất bại với thông báo rõ', async () => {
    const s = await shop(null);
    await enable(s.A, 'ext-req', { fail: true });
    await expect(mk(s)).rejects.toThrow(/extension "Extension bắt buộc" gặp lỗi \(hỏng bắt buộc\)/);
    await enable(s.A, 'ext-req', { fail: false });
    await expect(mk(s)).resolves.toBeDefined();
  });
  it('afterConfirm (cả khi tạo thẳng ở trạng thái đã xác nhận) và afterReturn; lỗi của extension không hủy việc xác nhận', async () => {
    const s = await shop({});
    calls.length = 0;
    const a = await mk(s, 'CONFIRMED');
    const b = await mk(s, 'QUOTE');
    await as(s.A, {}, (c) => confirmBooking(c, b.id));
    expect(calls).toEqual([`confirm:CONFIRMED:${s.A.slice(0, 4)}`, `confirm:CONFIRMED:${s.A.slice(0, 4)}`]);
    await enable(s.A, 'ext-a', { mode: 'crash' });
    const c3 = await mk(s, 'QUOTE');
    await as(s.A, {}, (c) => confirmBooking(c, c3.id));
    expect((await t.admin.query('SELECT status FROM booking WHERE id=$1', [c3.id])).rows[0].status).toBe('CONFIRMED');
    expect((await errors(s.A)).some((e) => e.hook === 'booking.afterConfirm')).toBe(true);
    await enable(s.A, 'ext-a', {});
    // nhận về
    const start = new Date(Date.now() - 20 * D), end = new Date(start.getTime() + D);
    const u = s.units[0]!.id;
    const { id } = await as(s.A, {}, (c) => createBooking(c, { customerId: s.cust, lines: [{ modelId: s.cam, qty: 1, unitId: u }], start, end, status: 'CONFIRMED' }));
    await as(s.A, {}, (c) => deliverBooking(c, id, { items: [{ unitId: u, condition: 'GOOD' }] }));
    await t.admin.query('UPDATE booking SET delivered_at = starts_at WHERE id=$1', [id]);
    calls.length = 0;
    await as(s.A, {}, (c) => receiveBooking(c, id, { returnedAt: new Date(end.getTime() + 5 * 3_600_000), items: [{ unitId: u, condition: 'GOOD' }] }));
    expect(calls).toEqual(['return:RETURNED:true']);
    void a;
  });
  it('notification.beforeSend: sửa nội dung, chặn tin, không cho đổi người nhận', async () => {
    const s = await shop({});
    const ins = (body: string) => t.admin.query(`INSERT INTO notification_log(tenant_id,event,channel,recipient,body,idempotency_key) VALUES ($1,'DUE','sms','0901234567',$2,$3)`, [s.A, body, `k-${Math.random()}`]);
    await t.admin.query(`UPDATE tenant SET settings = jsonb_build_object('notify', jsonb_build_object('v',1,'channels',jsonb_build_array('sms'),'quietHours',jsonb_build_object('enabled',false,'start','21:00','end','07:00'))) WHERE id=$1`, [s.A]);
    for (const b of ['binh thuong', 'DOI noi dung', 'CHAN tin nay', 'DOINGUOI']) await ins(b);
    const sent: string[] = [];
    const deps: NotifyDeps = { build: (cfg) => { const p = new ConsoleProvider(cfg.channel); const o = p.send.bind(p); p.send = async (m) => { sent.push(`${m.to}|${m.body}`); return o(m); }; return p; } };
    const r = await as(s.A, {}, (c) => dispatchQueued(c, new Date(Date.now() + 5000), deps));
    expect(r).toMatchObject({ sent: 3, skipped: 1 });
    expect(sent.sort()).toEqual(['0901234567|DOI noi dung [ext]', '0901234567|DOINGUOI', '0901234567|binh thuong'].sort()); // DOINGUOI: đổi người nhận bị từ chối nên giữ tin gốc
    const rows = (await t.admin.query('SELECT body, status, error FROM notification_log WHERE tenant_id=$1 ORDER BY body', [s.A])).rows;
    expect(rows.find((x) => x.body.startsWith('CHAN'))).toMatchObject({ status: 'SKIPPED', error: 'Extension của cửa hàng đã chặn tin này.' });
    expect(rows.find((x) => x.body === 'DOI noi dung [ext]')).toBeDefined(); // nhật ký ghi đúng nội dung đã gửi
    expect((await errors(s.A)).some((e) => e.hook === 'notification.beforeSend' && /không hợp lệ/.test(e.message))).toBe(true);
  });
  it('contract.extraVariables: dùng được trong mẫu hợp đồng, biến sai tên/quá dài bị bỏ qua', async () => {
    const s = await shop({});
    await as(s.A, {}, (c) => updateDocTemplates(c, { contract: { title: 'HỢP ĐỒNG', terms: ['Mã khách VIP: {ext.ma_vip}.', 'Không có: {ext.dai}{ext.ten_sai}'] } }));
    const b = await mk(s, 'CONFIRMED');
    await as(s.A, {}, (c) => createContract(c, b.id));
    const terms = (await as(s.A, {}, (c) => getContract(c, b.id))).active!.content.terms;
    expect(terms[0]).toBe(`Mã khách VIP: VIP-${s.A.slice(0, 4)}.`);
    expect(terms[1]).toBe('Không có:');
    expect((await errors(s.A)).filter((e) => e.hook === 'contract.extraVariables')).toHaveLength(2);
  });
});

describe('báo cáo, kho dữ liệu, truy vấn chỉ đọc, tác vụ nền', () => {
  it('báo cáo của extension xuất hiện đúng cửa hàng/quyền, chạy qua cùng cổng kiểm tra, lỗi có thông báo thân thiện', async () => {
    const s = await shop({});
    const B = await shop(null);
    await mk(s, 'QUOTE');
    await mk(s, 'QUOTE');
    const keys = (A: string, o: Opts = {}) => as(A, o, async (c) => listReports(c).map((d) => d.key).filter((k) => k.startsWith('ext.')));
    expect(await keys(s.A)).toEqual(['ext.ext-a.tong-don']);
    expect(await keys(B.A)).toEqual([]);
    expect(await keys(s.A, { role: 'STAFF' })).toEqual([]); // cần reports.finance
    expect(await keys(s.A, { off: ['extensions'] })).toEqual([]);
    const r = await as(s.A, {}, (c) => runReport(c, 'ext.ext-a.tong-don'));
    expect(r.cards![0]).toMatchObject({ label: 'Số đơn', value: 2 });
    expect(r.key).toBe('ext.ext-a.tong-don');
    await expect(as(s.A, { role: 'STAFF' }, (c) => runReport(c, 'ext.ext-a.tong-don'))).rejects.toThrow(ForbiddenError);
    await expect(as(B.A, {}, (c) => runReport(c, 'ext.ext-a.tong-don'))).rejects.toThrow(/không tồn tại/);
    await enable(s.A, 'ext-a', { mode: 'crash' });
    const broken = await as(s.A, {}, (c) => runReport(c, 'ext.ext-a.tong-don'));
    expect(broken.sections).toEqual([]);
    expect(broken.notes![0]).toMatch(/gặp lỗi và không hiển thị được/);
    expect((await errors(s.A)).some((e) => e.hook === 'report:tong-don' && e.message === 'hỏng báo cáo')).toBe(true);
  });

  it('truy vấn chỉ đọc: chỉ SELECT, RLS cô lập tenant, chặn lệnh ghi và đa câu lệnh', async () => {
    expect(validateReadSql('SELECT 1')).toBeNull();
    expect(validateReadSql('with x as (select 1) select * from x;')).toBeNull();
    for (const bad of ['DELETE FROM booking', 'select 1; select 2', 'select 1 -- x', 'select pg_sleep(5)', 'with x as (delete from booking returning *) select * from x', 'select nextval(\'a\')', 'update booking set total=0', 'insert into plan values (1)'])
      expect(validateReadSql(bad), bad).not.toBeNull();
    const s = await shop({});
    const B = await shop({});
    await mk(s, 'QUOTE');
    await mk(B, 'QUOTE');
    await mk(B, 'QUOTE');
    // dùng báo cáo của extension để chạy truy vấn thật: mỗi cửa hàng chỉ đếm đơn của chính mình
    expect((await as(s.A, {}, (c) => runReport(c, 'ext.ext-a.tong-don'))).cards![0]!.value).toBe(1);
    expect((await as(B.A, {}, (c) => runReport(c, 'ext.ext-a.tong-don'))).cards![0]!.value).toBe(2);
  });

  it('tác vụ nền của extension: chạy khi đến lịch, mỗi tác vụ một dòng nhật ký, tác vụ hỏng không chặn tác vụ khác và hoàn lại việc dở dang', async () => {
    const s = await shop({});
    const now = new Date('2027-03-10T10:00:00+07:00');
    const run = (at: Date) => as(s.A, {}, (c) => runExtensionJobs(c, at));
    expect(await run(now)).toEqual({ ran: 1, failed: 1, skipped: 0 });
    const logRows = async () => (await t.admin.query("SELECT name, ok, detail FROM job_run WHERE tenant_id=$1 AND name LIKE 'ext:%' ORDER BY name, started_at", [s.A])).rows;
    expect((await logRows()).map((r) => `${r.name}:${r.ok}`)).toEqual(['ext:ext-a:dong-bo:true', 'ext:ext-a:hong:false']);
    expect((await logRows())[1].detail).toEqual({ error: 'tác vụ hỏng' });
    const store = async (k: string) => (await t.admin.query("SELECT value FROM extension_data WHERE tenant_id=$1 AND extension_code='ext-a' AND key=$2", [s.A, k])).rows[0]?.value;
    expect(await store('lan')).toBe(1);
    expect(await store('truoc-khi-hong')).toBeUndefined(); // ghi dở của tác vụ hỏng được hoàn lại
    expect(await run(new Date(now.getTime() + 3 * 60_000))).toMatchObject({ ran: 0, skipped: 1, failed: 1 }); // dong-bo chưa tới 5 phút; "hong" chưa chạy thành công nên thử lại
    expect(await run(new Date(now.getTime() + 6 * 60_000))).toMatchObject({ ran: 1 });
    expect(await store('lan')).toBe(2);
    expect((await as(s.A, { off: ['extensions'] }, (c) => runExtensionJobs(c, now)))).toEqual({ ran: 0, failed: 0, skipped: 0 });
  });

  it('kho khóa–giá trị: tách theo extension và theo cửa hàng; lỗi ghi log nhưng không nằm trong nhật ký lỗi', async () => {
    const s = await shop({});
    const B = await shop({});
    await as(s.A, {}, (c) => runExtensionJobs(c, new Date()));
    await as(B.A, {}, (c) => runExtensionJobs(c, new Date()));
    const rows = (await t.admin.query("SELECT tenant_id, extension_code, key, value FROM extension_data WHERE key='lan'")).rows.filter((r) => [s.A, B.A].includes(r.tenant_id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.value === 1)).toBe(true);
    expect((await withTenantId(t.app, s.A, (db) => db.query('SELECT 1 FROM extension_data'))).rowCount).toBe(1); // RLS: chỉ thấy dữ liệu của mình
    await expect(withTenantId(t.app, B.A, (db) => db.query("INSERT INTO extension_data(tenant_id,extension_code,key,value) VALUES ($1,'ext-a','x','1')", [s.A]))).rejects.toThrow();
  });

  it('nhật ký lỗi extension: quản trị xem được, cửa hàng không sửa/xóa được', async () => {
    const s = await shop({ mode: 'crash' });
    await mk(s, 'QUOTE');
    const errs = await listExtensionErrors(t.platform, s.A);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatchObject({ extension_code: 'ext-a' });
    await expect(withTenantId(t.app, s.A, (db) => db.query('DELETE FROM extension_error_log'))).rejects.toThrow(/permission denied/);
    await expect(withTenantId(t.app, s.A, (db) => db.query("UPDATE extension_error_log SET message='x'"))).rejects.toThrow(/permission denied/);
  });
});

describe('migration riêng của extension', () => {
  it('áp dụng một lần, bảng có RLS và quyền cho role ứng dụng; sửa migration đã chạy bị từ chối', async () => {
    // migration tạo bảng cần quyền DDL: chạy bằng kết nối quản trị CSDL (như migrate lõi), không phải rentpro_admin
    expect(await applyExtensionMigrations(t.admin)).toEqual(['dbx:001']);
    expect(await applyExtensionMigrations(t.admin)).toEqual([]);
    const A = await mkTenant(t, 'full');
    const B = await mkTenant(t, 'full');
    await withTenantId(t.app, A, (db) => db.query("INSERT INTO ext_dbx_note(tenant_id, body) VALUES ($1,'ghi chú của A')", [A]));
    expect((await withTenantId(t.app, B, (db) => db.query('SELECT 1 FROM ext_dbx_note'))).rowCount).toBe(0);
    expect((await withTenantId(t.app, A, (db) => db.query('SELECT body FROM ext_dbx_note'))).rows).toEqual([{ body: 'ghi chú của A' }]);
    await expect(withTenantId(t.app, B, (db) => db.query("INSERT INTO ext_dbx_note(tenant_id, body) VALUES ($1,'x')", [A]))).rejects.toThrow();
    const changed: ExtensionDefinition = { ...extDb, manifest: { ...extDb.manifest, migrations: [{ id: '001', sql: extDb.manifest.migrations![0]!.sql + '\n-- sửa' }] } };
    await expect(applyExtensionMigrations(t.admin, [changed])).rejects.toThrow(/nội dung đã bị sửa/);
    const evil: ExtensionDefinition = { ...extDb, manifest: { ...extDb.manifest, code: 'ext-evil', migrations: [{ id: '001', sql: 'DROP TABLE booking' }] } };
    await expect(applyExtensionMigrations(t.admin, [evil])).rejects.toThrow(/không hợp lệ/);
    expect((await t.admin.query("SELECT to_regclass('booking') r")).rows[0].r).toBe('booking');
  });
});

void createFieldDef;
