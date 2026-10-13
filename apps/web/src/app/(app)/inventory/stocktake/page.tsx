import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listBranches, listStocktakes, startStocktake } from '@rentpro/db';
import { Empty, Field, Notice, btn, card, input } from '@/components/ui';
import { run, withService } from '@/lib/service';
import { requireAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function start(form: FormData) {
  'use server';
  await run('/inventory/stocktake', async () => {
    const id = await withService((c) => startStocktake(c, { name: String(form.get('name') ?? ''), branchId: String(form.get('branchId') ?? '') || null }));
    return `/inventory/stocktake/${id}`;
  });
}

export default async function StocktakePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAppSession();
  if (!s.tenant.features['inventory.stocktake']) redirect('/inventory?error=' + encodeURIComponent('Gói hiện tại chưa có tính năng kiểm kê.'));
  const f = await searchParams;
  const { list, branches } = await withService(async (c) => ({ list: await listStocktakes(c), branches: await listBranches(c) }));
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Kiểm kê</h1>
      <Notice error={f.error} />
      <form action={start} className={`${card} flex flex-wrap items-end gap-3`}>
        <Field label="Tên đợt kiểm kê"><input name="name" required placeholder="Kiểm kê cuối tháng 10" className={input} /></Field>
        <Field label="Chi nhánh"><select name="branchId" className={input}><option value="">Toàn bộ</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <button className={btn}>Bắt đầu</button>
      </form>
      {list.length === 0 ? <Empty>Chưa có đợt kiểm kê nào.</Empty> : (
        <ul className="divide-y rounded-lg bg-white shadow-sm">
          {list.map((k) => (
            <li key={k.id} className="flex items-center justify-between p-3 text-sm">
              <Link className="font-medium underline" href={`/inventory/stocktake/${k.id}`}>{k.name}</Link>
              <span className="text-slate-500">{k.branch_name ?? 'Toàn bộ'} · {k.scans} lượt quét · {k.status === 'OPEN' ? 'Đang mở' : 'Đã đóng'} · {new Date(k.created_at).toLocaleDateString('vi-VN')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
