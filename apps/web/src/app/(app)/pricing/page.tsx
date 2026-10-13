import Link from 'next/link';
import { redirect } from 'next/navigation';
import { clearRule, createPriceList, ensureDefaultPriceList, listPriceLists, listRules, setRule } from '@rentpro/db';
import { Notice, btn, btnGhost, card, input } from '@/components/ui';
import { run, withService } from '@/lib/service';
import { requireAppSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const money = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim().replace(/[.,\s]/g, '');
  return s === '' ? null : Number(s);
};

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ list?: string; error?: string; ok?: string }> }) {
  const s = await requireAppSession();
  if (!s.tenant.features.pricing) redirect('/?error=' + encodeURIComponent('Gói hiện tại chưa có tính năng bảng giá.'));
  const f = await searchParams;
  const { lists, listId, rules, canManage } = await withService(async (c, sess) => {
    const def = await ensureDefaultPriceList(c);
    const lists = await listPriceLists(c);
    const listId = lists.some((l) => l.id === f.list) ? f.list! : def;
    return { lists, listId, rules: await listRules(c, listId), canManage: sess.permissions.has('pricing.manage') };
  });
  const back = `/pricing?list=${listId}`;

  async function save(form: FormData) {
    'use server';
    await run(back, async () => {
      await withService((c) => setRule(c, listId, String(form.get('modelId')), {
        hour: money(form.get('hour')), day: money(form.get('day')), week: money(form.get('week')), month: money(form.get('month')), minHours: Number(form.get('minHours') || 0),
      }));
      return `${back}&ok=${encodeURIComponent('Đã lưu giá.')}`;
    });
  }
  async function clear(form: FormData) {
    'use server';
    await run(back, async () => { await withService((c) => clearRule(c, listId, String(form.get('modelId')))); return `${back}&ok=${encodeURIComponent('Đã xóa giá.')}`; });
  }
  async function addList(form: FormData) {
    'use server';
    await run(back, async () => {
      const id = await withService((c) => createPriceList(c, String(form.get('name') ?? '')));
      return `/pricing?list=${id}&ok=${encodeURIComponent('Đã tạo bảng giá.')}`;
    });
  }

  const cell = 'w-28 rounded border px-2 py-1 text-right';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Bảng giá</h1>
        <div className="flex gap-2 text-sm"><Link className={btnGhost} href="/pricing/quote">Báo giá thử</Link>{s.permissions.has('settings.manage') && <Link className={btnGhost} href="/settings/pricing">Quy tắc tính giá</Link>}</div>
      </div>
      <Notice error={f.error} ok={f.ok} />
      <nav className="flex flex-wrap gap-2" aria-label="Chọn bảng giá">
        {lists.map((l) => <Link key={l.id} href={`/pricing?list=${l.id}`} className={`rounded px-3 py-1 text-sm ${l.id === listId ? 'bg-slate-900 text-white' : 'bg-white'}`}>{l.name}{l.isDefault ? ' (mặc định)' : ''}</Link>)}
      </nav>
      <p className="text-sm text-slate-600">Giá tính bằng VND cho một thiết bị. Để trống ô nào thì không áp dụng đơn vị đó. Hệ thống tự chọn tổ hợp rẻ nhất cho khách (VD 9 ngày = 1 tuần + 2 ngày nếu rẻ hơn).</p>
      <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-50 text-slate-500"><tr><th className="p-3">Mẫu</th><th>Giờ</th><th>Ngày</th><th>Tuần</th><th>Tháng</th><th>Tối thiểu (giờ)</th><th></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.modelId} className="border-b last:border-0">
                <td className="p-3 font-medium">{r.modelName}{!r.rule && <span className="ml-2 text-xs font-normal text-amber-700">chưa có giá</span>}</td>
                {canManage ? (
                  <>
                    <td colSpan={6} className="p-2">
                      <form action={save} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="modelId" value={r.modelId} />
                        <input name="hour" aria-label={`Giá giờ ${r.modelName}`} defaultValue={r.rule?.hour ?? ''} className={cell} inputMode="numeric" />
                        <input name="day" aria-label={`Giá ngày ${r.modelName}`} defaultValue={r.rule?.day ?? ''} className={cell} inputMode="numeric" />
                        <input name="week" aria-label={`Giá tuần ${r.modelName}`} defaultValue={r.rule?.week ?? ''} className={cell} inputMode="numeric" />
                        <input name="month" aria-label={`Giá tháng ${r.modelName}`} defaultValue={r.rule?.month ?? ''} className={cell} inputMode="numeric" />
                        <input name="minHours" aria-label={`Giờ tối thiểu ${r.modelName}`} defaultValue={r.rule?.minHours ?? 0} className="w-16 rounded border px-2 py-1 text-right" inputMode="numeric" />
                        <button className={`${btn} px-3 py-1`}>Lưu</button>
                        {r.rule && <button formAction={clear} className="text-red-700 underline">Xóa</button>}
                      </form>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{r.rule?.hour ?? '—'}</td><td>{r.rule?.day ?? '—'}</td><td>{r.rule?.week ?? '—'}</td><td>{r.rule?.month ?? '—'}</td><td>{r.rule?.minHours ?? '—'}</td><td></td>
                  </>
                )}
              </tr>
            ))}
            {rules.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-500">Chưa có mẫu thiết bị. Hãy tạo mẫu trước.</td></tr>}
          </tbody>
        </table>
      </div>
      {canManage && (
        <form action={addList} className={`${card} flex flex-wrap items-end gap-2`}>
          <label className="text-sm">Bảng giá mới (VD: Giá đối tác)<input name="name" required className={`${input} mt-1`} /></label>
          <button className={btn}>Tạo bảng giá</button>
        </form>
      )}
    </div>
  );
}
