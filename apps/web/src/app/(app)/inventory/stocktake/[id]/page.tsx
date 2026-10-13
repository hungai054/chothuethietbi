import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { UNIT_STATUS_LABEL, type StocktakeUnit, type UnitStatus } from '@rentpro/core';
import { NotFoundError, closeStocktake, stocktakeReport } from '@rentpro/db';
import { Notice, btn, card } from '@/components/ui';
import { Scanner } from '@/components/scanner';
import { run, withService } from '@/lib/service';
import { requireAppSession } from '@/lib/session';
import { stocktakeScanAction } from '../../scan/actions';

export const dynamic = 'force-dynamic';

function Section({ title, tone, units }: { title: string; tone: string; units: StocktakeUnit[] }) {
  return (
    <details className={card} open={units.length > 0 && tone !== 'ok'}>
      <summary className="cursor-pointer font-medium">{title} ({units.length})</summary>
      <ul className="mt-2 grid gap-1 text-sm md:grid-cols-2">
        {units.map((u) => <li key={u.id}><Link className="font-mono underline" href={`/inventory/units/${u.id}`}>{u.barcode}</Link> · {u.name} · {UNIT_STATUS_LABEL[u.status as UnitStatus]}</li>)}
      </ul>
    </details>
  );
}

export default async function StocktakeDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const s = await requireAppSession();
  if (!s.tenant.features['inventory.stocktake']) redirect('/inventory');
  const f = await searchParams;
  const data = await withService(async (c) => {
    try { return await stocktakeReport(c, id); } catch (e) { if (e instanceof NotFoundError) return null; throw e; }
  });
  if (!data) notFound();
  const { stocktake, result } = data;
  const open = stocktake.status === 'OPEN';

  async function close() {
    'use server';
    await run(`/inventory/stocktake/${id}`, async () => {
      await withService((c) => closeStocktake(c, id));
      return `/inventory/stocktake/${id}`;
    });
  }

  return (
    <div className="space-y-4">
      <Link href="/inventory/stocktake" className="text-sm underline">← Các đợt kiểm kê</Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{stocktake.name} <span className="text-base font-normal text-slate-500">{open ? '(đang mở)' : '(đã đóng)'}</span></h1>
        {open && <form action={close}><button className={btn}>Đóng đợt kiểm kê</button></form>}
      </div>
      <Notice error={f.error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 text-center">
        {[['Khớp', result.matched.length], ['Thiếu', result.missing.length], ['Sai chi nhánh', result.wrongBranch.length], ['Cần xem lại', result.unexpected.length]].map(([l, n]) => (
          <div key={l as string} className={card}><div className="text-2xl font-semibold">{n}</div><div className="text-sm text-slate-500">{l}</div></div>
        ))}
      </div>
      {open && <div className={card}><Scanner action={stocktakeScanAction.bind(null, id)} /><p className="mt-2 text-xs text-slate-500">Số liệu phía trên cập nhật khi tải lại trang.</p></div>}
      <Section title="Thiếu (chưa quét được)" tone="bad" units={result.missing} />
      <Section title="Sai chi nhánh" tone="warn" units={result.wrongBranch} />
      <Section title="Cần xem lại (hệ thống ghi đang thuê/mất/thanh lý nhưng quét thấy)" tone="warn" units={result.unexpected} />
      <Section title="Khớp" tone="ok" units={result.matched} />
    </div>
  );
}
