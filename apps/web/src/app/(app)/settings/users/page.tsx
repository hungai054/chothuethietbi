import Link from 'next/link';
import { TENANT_ROLES, type TenantRole } from '@rentpro/core';
import { createUser, listCustomRoles, listUsers, setUserPassword, updateUser } from '@rentpro/db';
import { Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { fmtDate } from '@/lib/format';
import { okUrl } from '@/lib/forms';
import { requireAppSession } from '@/lib/session';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const BACK = '/settings/users';
const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const ROLE_LABEL: Record<TenantRole, string> = { OWNER: 'Chủ cửa hàng', MANAGER: 'Quản lý', STAFF: 'Nhân viên quầy', TECHNICIAN: 'Kỹ thuật viên' };

async function create(f: FormData) {
  'use server';
  await run(BACK, async () => {
    await withService((c) => createUser(c, { email: s(f, 'email'), name: s(f, 'name'), password: String(f.get('password') ?? ''), role: s(f, 'role') as TenantRole, customRoleId: s(f, 'customRoleId') || null }));
    return okUrl(BACK, 'Đã tạo tài khoản.');
  });
}
async function update(id: string, f: FormData) {
  'use server';
  await run(BACK, async () => {
    await withService((c) => updateUser(c, id, { name: s(f, 'name'), role: s(f, 'role') as TenantRole, customRoleId: s(f, 'customRoleId') || null, active: f.get('active') === 'on' }));
    return okUrl(BACK, 'Đã lưu người dùng.');
  });
}
async function resetPassword(id: string, f: FormData) {
  'use server';
  await run(BACK, async () => { await withService((c) => setUserPassword(c, id, String(f.get('password') ?? ''))); return okUrl(BACK, 'Đã đặt lại mật khẩu.'); });
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const sess = await requireAppSession();
  const q = await searchParams;
  if (!sess.permissions.has('users.manage')) return <p className="rounded bg-white p-6 text-slate-600">Bạn không có quyền quản lý người dùng.</p>;
  const isOwner = sess.permissions.has('roles.manage');
  const { users, roles } = await withService(async (c) => ({ users: await listUsers(c), roles: sess.tenant.features.custom_roles ? await listCustomRoles(c) : [] }));
  const roleChoices = TENANT_ROLES.filter((r) => isOwner || r !== 'OWNER');
  const used = users.filter((u) => u.active).length;
  const limit = sess.tenant.limits.users;
  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Người dùng</h1>
      <p className="text-sm text-slate-600" data-testid="user-count">Đang hoạt động: {used}{limit !== null ? ` / ${limit}` : ''}</p>
      <Notice error={q.error} ok={q.ok} />
      <div className="space-y-3" data-testid="user-list">
        {users.map((u) => {
          const locked = u.role === 'OWNER' && !isOwner;
          return (
            <div key={u.id} className={`${card} space-y-2 ${u.active ? '' : 'opacity-60'}`}>
              <form action={update.bind(null, u.id)} className="flex flex-wrap items-end gap-3 text-sm">
                <div className="min-w-48 flex-1"><input name="name" defaultValue={u.name} aria-label={`Tên ${u.email}`} disabled={locked} className={input} /><div className="mt-1 text-xs text-slate-500">{u.email} · tạo {fmtDate(u.createdAt, sess.tenant.timezone)}</div></div>
                <select name="role" defaultValue={u.role} aria-label={`Vai trò ${u.email}`} disabled={locked} className="rounded border bg-white px-3 py-2">{roleChoices.concat(u.role === 'OWNER' && !isOwner ? ['OWNER'] : []).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
                {sess.tenant.features.custom_roles && (
                  <select name="customRoleId" defaultValue={u.customRoleId ?? ''} aria-label={`Vai trò tùy chỉnh ${u.email}`} disabled={locked} className="rounded border bg-white px-3 py-2">
                    <option value="">— quyền mặc định của vai trò —</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                )}
                <label className="flex items-center gap-1"><input type="checkbox" name="active" defaultChecked={u.active} disabled={locked} /> Hoạt động</label>
                {!locked && <button className={btnGhost}>Lưu</button>}
              </form>
              {!locked && (
                <form action={resetPassword.bind(null, u.id)} className="flex flex-wrap items-center gap-2 text-sm">
                  <input name="password" type="password" autoComplete="new-password" placeholder="Mật khẩu mới (≥10 ký tự, có chữ và số)" aria-label={`Mật khẩu mới ${u.email}`} className={`${input} max-w-xs`} />
                  <button className="text-xs underline">Đặt lại mật khẩu</button>
                </form>
              )}
            </div>
          );
        })}
      </div>
      <form action={create} className={`${card} space-y-3`} data-testid="user-form">
        <h2 className="font-medium">Thêm người dùng</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Email (*)"><input name="email" type="email" required className={input} /></Field>
          <Field label="Họ tên (*)"><input name="name" required className={input} /></Field>
          <Field label="Mật khẩu ban đầu (*)"><input name="password" type="password" required autoComplete="new-password" className={input} /></Field>
          <Field label="Vai trò"><select name="role" defaultValue="STAFF" className={input}>{roleChoices.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
          {sess.tenant.features.custom_roles && (
            <Field label="Vai trò tùy chỉnh (tùy chọn, thay quyền mặc định)"><select name="customRoleId" className={input}><option value="">—</option>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          )}
        </div>
        <button className={btn}>Tạo tài khoản</button>
        <p className="text-xs text-slate-500">Hãy gửi mật khẩu cho nhân viên qua kênh riêng tư và nhắc đổi sau lần đăng nhập đầu. Khóa tài khoản có hiệu lực ngay, kể cả khi người đó đang đăng nhập.</p>
      </form>
    </div>
  );
}
