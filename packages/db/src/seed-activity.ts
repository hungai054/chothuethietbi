import pg from 'pg';
import { resolveFeatures, resolveLimits, FEATURE_KEYS } from '@rentpro/tenancy';
import { permissionsFor } from '@rentpro/core';
import { createBooking } from './booking';
import { withTenantId } from './client';
import { recordPayment } from './finance';
import { listCustomers } from './customers';
import { listModels } from './inventory';
import { ensureDefaultPriceList } from './pricing';
import type { ServiceCtx } from './service';

/**
 * Đơn mẫu cho cửa hàng demo để các trang (lịch, báo cáo, công nợ, nhật ký) có dữ liệu ngay. Đi qua CHÍNH các service nghiệp vụ nên
 * dữ liệu hợp lệ như dữ liệu thật. Chỉ chạy khi demo chưa có đơn nào, nên chạy lại seed không nhân đôi.
 */
export async function seedDemoActivity(adminUrl: string, now = new Date()): Promise<number> {
  const u = new URL(adminUrl);
  u.username = 'rentpro_app'; u.password = 'rentpro_app';
  const app = new pg.Pool({ connectionString: u.toString() });
  const admin = new pg.Pool({ connectionString: adminUrl });
  try {
    const tenant = (await admin.query("SELECT id, timezone FROM tenant WHERE slug='demo'")).rows[0] as { id: string; timezone: string } | undefined;
    if (!tenant || (await admin.query('SELECT 1 FROM booking WHERE tenant_id=$1 LIMIT 1', [tenant.id])).rowCount) return 0;
    const owner = (await admin.query("SELECT id FROM app_user WHERE tenant_id=$1 AND role='OWNER' LIMIT 1", [tenant.id])).rows[0]?.id as string | undefined;
    const features = resolveFeatures({ planFeatures: Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])), overrides: {} });
    return await withTenantId(app, tenant.id, async (db) => {
      const ctx: ServiceCtx = {
        db, tenantId: tenant.id, tenantStatus: 'ACTIVE', userId: owner ?? null, permissions: permissionsFor('OWNER'),
        features, limits: resolveLimits({}, {}), timezone: tenant.timezone,
      };
      await ensureDefaultPriceList(ctx);
      const customers = (await listCustomers(ctx, { pageSize: 10 })).rows;
      const models = await listModels(ctx);
      const byName = (s: string) => models.find((m) => m.name.includes(s));
      const cam = byName('Sony A7'), len = byName('24-70'), mic = byName('Rode'), light = byName('Godox'), r6 = byName('Canon');
      if (customers.length < 4 || !cam || !len || !mic || !light || !r6) return 0;
      const day = (n: number, h = 9) => { const d = new Date(now); d.setUTCDate(d.getUTCDate() + n); d.setUTCHours(h - 7, 0, 0, 0); return d; }; // giờ Việt Nam
      const plan: { c: number; items: { m: string; q: number }[]; s: number; e: number; status: 'QUOTE' | 'HOLD' | 'CONFIRMED'; deposit?: number; notes?: string }[] = [
        { c: 0, items: [{ m: cam.id, q: 1 }, { m: len.id, q: 1 }], s: 1, e: 3, status: 'CONFIRMED', deposit: 2_000_000, notes: 'Quay phóng sự cưới' },
        { c: 1, items: [{ m: r6.id, q: 1 }], s: 2, e: 4, status: 'CONFIRMED', deposit: 1_000_000 },
        { c: 2, items: [{ m: mic.id, q: 2 }, { m: light.id, q: 2 }], s: 5, e: 6, status: 'HOLD', notes: 'Giữ chỗ chờ khách chuyển khoản' },
        { c: 3, items: [{ m: cam.id, q: 2 }], s: 7, e: 10, status: 'QUOTE', notes: 'Báo giá cho Studio, chưa chốt' },
        { c: 4, items: [{ m: len.id, q: 2 }, { m: mic.id, q: 1 }], s: 4, e: 5, status: 'CONFIRMED' },
      ];
      let n = 0;
      for (const p of plan) {
        const b = await createBooking(ctx, {
          customerId: customers[p.c]!.id, lines: p.items.map((i) => ({ modelId: i.m, qty: i.q })), start: day(p.s), end: day(p.e, 18), status: p.status, notes: p.notes ?? null,
        });
        if (p.deposit) await recordPayment(ctx, { bookingId: b.id, kind: 'DEPOSIT', method: 'BANK_TRANSFER', amount: p.deposit, note: 'Dữ liệu mẫu', idempotencyKey: `seed-${b.id}` });
        n++;
      }
      return n;
    });
  } finally {
    await Promise.all([app.end(), admin.end()]);
  }
}
