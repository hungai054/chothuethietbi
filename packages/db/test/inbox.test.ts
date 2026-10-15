import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './helpers';
import { mkTenant, runAs, type Opts } from './ctx';
import { listInbox, markInboxRead, pushInbox } from '../src';

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb(54339);
  await t.admin.query("INSERT INTO plan(code,name) VALUES ('p','P')");
}, 120_000);
afterAll(async () => { await t?.stop(); });

const as = <T,>(id: string, o: Opts, fn: Parameters<typeof runAs<T>>[3]) => runAs(t, id, o, fn);
const U1 = '00000000-0000-0000-0000-0000000000a1';
const U2 = '00000000-0000-0000-0000-0000000000a2';

describe('trung tâm thông báo', () => {
  it('đếm chưa đọc trên toàn bộ (không bị cắt theo giới hạn trang), lọc chưa đọc, đánh dấu từng người', async () => {
    const A = await mkTenant(t);
    for (let i = 0; i < 7; i++) await as(A, {}, (c) => pushInbox(c, { kind: 'test', title: `Tin ${i}`, dedupeKey: `k${i}`, permission: null }));
    const first = await as(A, { userId: U1 }, (c) => listInbox(c, 3));
    expect(first.items).toHaveLength(3);
    expect(first.unread).toBe(7);
    expect(first.total).toBe(7);

    await as(A, { userId: U1 }, (c) => markInboxRead(c, first.items[0]!.id));
    const after = await as(A, { userId: U1 }, (c) => listInbox(c, 50));
    expect(after.unread).toBe(6);
    expect(after.items.find((i) => i.id === first.items[0]!.id)!.read).toBe(true);
    expect((await as(A, { userId: U2 }, (c) => listInbox(c))).unread).toBe(7); // người khác vẫn chưa đọc

    const only = await as(A, { userId: U1 }, (c) => listInbox(c, 50, { unreadOnly: true }));
    expect(only.items).toHaveLength(6);
    expect(only.items.every((i) => !i.read)).toBe(true);

    await as(A, { userId: U1 }, (c) => markInboxRead(c));
    expect((await as(A, { userId: U1 }, (c) => listInbox(c))).unread).toBe(0);
  });

  it('chỉ thấy thông báo đúng quyền và đúng cửa hàng', async () => {
    const A = await mkTenant(t);
    const B = await mkTenant(t);
    await as(A, {}, (c) => pushInbox(c, { kind: 'x', title: 'Chỉ quản lý', dedupeKey: 'm', permission: 'reports.finance' }));
    await as(A, {}, (c) => pushInbox(c, { kind: 'x', title: 'Cho mọi người', dedupeKey: 'all', permission: null }));
    expect((await as(A, { role: 'MANAGER', userId: U1 }, (c) => listInbox(c))).items.map((i) => i.title).sort()).toEqual(['Cho mọi người', 'Chỉ quản lý']);
    expect((await as(A, { role: 'TECHNICIAN', userId: U1 }, (c) => listInbox(c))).items.map((i) => i.title)).toEqual(['Cho mọi người']);
    expect((await as(A, { role: 'TECHNICIAN', userId: U1 }, (c) => listInbox(c))).total).toBe(1);
    expect((await as(B, { userId: U1 }, (c) => listInbox(c))).total).toBe(0);
  });
});
