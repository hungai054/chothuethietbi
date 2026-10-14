import Link from 'next/link';
import { OWNER_ONLY_PERMISSIONS, PERMISSIONS, PERMISSION_GROUPS, PERMISSION_LABEL, type Permission } from '@rentpro/core';
import { createCustomRole, deleteCustomRole, listCustomRoles, updateCustomRole } from '@rentpro/db';
import { Empty, Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const BACK = '/settings/roles';
const picked = (f: FormData) => PERMISSIONS.filter((p) => f.get(`p:${p}`) === 'on');
const added = (a: Permission[]) => (a.length ? ` Đã tự thêm quyền xem đi kèm: ${a.map((p) => PERMISSION_LABEL[p]).join(', ')}.` : '');

async function create(f: FormData) {
  'use server';
  await run(BACK, async () => {
    const r = await withService((c) => createCustomRole(c, String(f.get('name') ?? ''), picked(f)));
    return okUrl(BACK, `Đã tạo vai trò.${added(r.added)}`);
  });
}
async function update(id: string, f: FormData) {
  'use server';
  await run(BACK, async () => {
    const r = await withService((c) => updateCustomRole(c, id, String(f.get('name') ?? ''), picked(f)));
    return okUrl(BACK, `Đã lưu vai trò.${added(r.added)}`);
  });
}
async function remove(id: string) {
  'use server';
  await run(BACK, async () => { await withService((c) => deleteCustomRole(c, id)); return okUrl(BACK, 'Đã xóa vai trò.'); });
}

function Matrix({ checked }: { checked: readonly Permission[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {PERMISSION_GROUPS.map((g) => (
        <fieldset key={g.title} className="rounded border p-2 text-sm">
          <legend className="px-1 text-xs font-medium text-slate-500">{g.title}</legend>
          {g.perms.map((p) => <label key={p} className="flex items-center gap-1"><input type="checkbox" name={`p:${p}`} defaultChecked={checked.includes(p)} /> {PERMISSION_LABEL[p]}</label>)}
        </fieldset>
      ))}
    </div>
  );
}

export default async function RolesPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireAccess('custom_roles', 'roles.manage');
  const q = await searchParams;
  const roles = await withService((c) => listCustomRoles(c));
  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Vai trò tùy chỉnh</h1>
      <p className="text-sm text-slate-600">Tạo vai trò với đúng quyền cần thiết (VD &quot;Thu ngân&quot;: chỉ thu tiền và xem đơn). Quyền {OWNER_ONLY_PERMISSIONS.map((p) => PERMISSION_LABEL[p].toLowerCase()).join(', ')} chỉ dành cho chủ cửa hàng. Có quyền sửa thì tự có quyền xem tương ứng.</p>
      <Notice error={q.error} ok={q.ok} />
      {roles.length === 0 ? <Empty>Chưa có vai trò tùy chỉnh.</Empty> : roles.map((r) => (
        <section key={r.id} className={`${card} space-y-3`} data-testid="role-card">
          <form action={update.bind(null, r.id)} className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Tên vai trò"><input name="name" defaultValue={r.name} className={input} /></Field>
              <span className="pb-2 text-sm text-slate-500">{r.users} người dùng</span>
              <button className={btnGhost}>Lưu</button>
            </div>
            <Matrix checked={r.permissions} />
          </form>
          <form action={remove.bind(null, r.id)}><button className="text-xs text-red-700 underline">Xóa vai trò</button></form>
        </section>
      ))}
      <form action={create} className={`${card} space-y-3`} data-testid="role-form">
        <h2 className="font-medium">Thêm vai trò</h2>
        <Field label="Tên vai trò (*)"><input name="name" required className={`${input} max-w-xs`} /></Field>
        <Matrix checked={[]} />
        <button className={btn}>Tạo vai trò</button>
      </form>
    </div>
  );
}
