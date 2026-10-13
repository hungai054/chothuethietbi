import Link from 'next/link';
import { createGroup, listGroups, listPriceLists } from '@rentpro/db';
import { Field, Notice, btn, card, input } from '@/components/ui';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

async function add(form: FormData) {
  'use server';
  await run('/customers/groups', async () => {
    await withService((c) => createGroup(c, {
      name: String(form.get('name') ?? ''), discountPercent: Number(form.get('discount') || 0), priceListId: String(form.get('priceListId') ?? '') || null,
    }));
    return `/customers/groups?ok=${encodeURIComponent('Đã tạo nhóm khách.')}`;
  });
}

export default async function GroupsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const f = await searchParams;
  const { groups, lists, canManage, hasPricing } = await withService(async (c, s) => ({
    groups: await listGroups(c), canManage: s.permissions.has('customer.manage'),
    hasPricing: s.tenant.features.pricing, lists: s.tenant.features.pricing ? await listPriceLists(c) : [],
  }));
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/customers" className="text-sm underline">← Khách hàng</Link>
      <h1 className="text-2xl font-semibold">Nhóm khách</h1>
      <Notice error={f.error} ok={f.ok} />
      <ul className="divide-y rounded-lg bg-white shadow-sm">
        {groups.length === 0 && <li className="p-4 text-slate-500">Chưa có nhóm nào.</li>}
        {groups.map((g) => (
          <li key={g.id} className="flex justify-between p-3 text-sm"><b>{g.name}</b>
            <span className="text-slate-500">Giảm {g.discountPercent}%{g.priceListId ? ` · bảng giá: ${lists.find((l) => l.id === g.priceListId)?.name ?? 'riêng'}` : ''}</span></li>
        ))}
      </ul>
      {canManage && (
        <form action={add} className={`${card} grid gap-3 md:grid-cols-4`}>
          <Field label="Tên nhóm"><input name="name" required className={input} /></Field>
          <Field label="Giảm giá (%)"><input name="discount" type="number" min={0} max={100} step="0.5" defaultValue={0} className={input} /></Field>
          {hasPricing && <Field label="Bảng giá"><select name="priceListId" className={input}><option value="">Giá niêm yết</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
          <div className="flex items-end"><button className={btn}>Thêm nhóm</button></div>
        </form>
      )}
    </div>
  );
}
