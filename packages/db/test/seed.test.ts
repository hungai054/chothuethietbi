import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { seed } from '../src/seed';

let t: TestDb;
beforeAll(async () => { t = await startTestDb(54340); }, 120_000);
afterAll(async () => { await t?.stop(); });

const adminUrl = () => (t.admin as unknown as { options: { connectionString: string } }).options.connectionString;

describe('seed demo', () => {
  it('tạo cửa hàng demo có đơn mẫu hợp lệ và chạy lại không nhân đôi dữ liệu', async () => {
    await seed(adminUrl());
    const q = async (sql: string) => (await t.admin.query(sql)).rows;
    const first = (await q("SELECT count(*)::int AS n FROM booking b JOIN tenant t ON t.id=b.tenant_id WHERE t.slug='demo'"))[0].n as number;
    expect(first).toBe(5);
    const st = (await q("SELECT status, count(*)::int AS n FROM booking GROUP BY status ORDER BY status")).map((r) => `${r.status}:${r.n}`);
    expect(st).toEqual(['CONFIRMED:3', 'HOLD:1', 'QUOTE:1']);
    expect((await q("SELECT count(*)::int AS n FROM payment WHERE kind='DEPOSIT'"))[0].n).toBe(2);
    expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'booking.%'"))[0].n).toBeGreaterThanOrEqual(5);
    // mã đơn không trùng, tiền là số nguyên dương
    expect((await q('SELECT count(DISTINCT code)::int AS n FROM booking'))[0].n).toBe(5);
    expect((await q('SELECT count(*)::int AS n FROM booking WHERE total <= 0'))[0].n).toBe(0);

    await seed(adminUrl());
    expect((await q('SELECT count(*)::int AS n FROM booking'))[0].n).toBe(5);
    expect((await q('SELECT count(*)::int AS n FROM equipment_model'))[0].n).toBe(5);
  });
});
