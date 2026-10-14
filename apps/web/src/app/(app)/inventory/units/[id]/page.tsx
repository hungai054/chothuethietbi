import { CustomFieldsPanel } from '@/components/custom-fields';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SYSTEM_ONLY, UNIT_STATUS_LABEL, nextStatuses, type UnitStatus } from '@rentpro/core';
import { NotFoundError, getUnitDetail, softDeleteUnit, transitionUnit } from '@rentpro/db';
import { Notice, btn, btnGhost, card, input } from '@/components/ui';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const NEEDS_REASON = new Set<UnitStatus>(['MAINTENANCE', 'LOST', 'RETIRED']);

export default async function UnitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const f = await searchParams;
  const data = await withService(async (c, s) => {
    try {
      return { ...(await getUnitDetail(c, id)), canManage: s.permissions.has('inventory.manage'), canLabel: s.tenant.features['inventory.barcode'] };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data) notFound();
  const { unit, history, canManage, canLabel } = data;
  const status = unit.status as UnitStatus;
  const manual = nextStatuses(status).filter((s) => !SYSTEM_ONLY.has(s));

  async function change(form: FormData) {
    'use server';
    await run(`/inventory/units/${id}`, async () => {
      await withService((c) => transitionUnit(c, id, String(form.get('to')) as UnitStatus, { reason: String(form.get('reason') ?? '') }));
      return `/inventory/units/${id}?ok=${encodeURIComponent('Đã cập nhật trạng thái.')}`;
    });
  }
  async function remove(form: FormData) {
    'use server';
    await run(`/inventory/units/${id}`, async () => {
      await withService((c) => softDeleteUnit(c, id, String(form.get('reason') ?? '')));
      return `/inventory?ok=${encodeURIComponent('Đã xóa thiết bị.')}`;
    });
  }

  return (
    <div className="space-y-4">
      <Link href="/inventory" className="text-sm underline">← Danh sách</Link>

      <div className={card}>
        <h1 className="text-xl font-semibold"><span className="font-mono">{unit.barcode}</span> · {unit.model_name}</h1>
        <p className="mt-1 text-sm text-slate-600">Trạng thái: <b>{UNIT_STATUS_LABEL[status]}</b> · Serial: {unit.serial ?? '—'} · Tình trạng: {unit.condition}</p>
        {canLabel && <a className="mt-2 inline-block text-sm underline" target="_blank" href={`/inventory/labels?ids=${unit.id}`}>In tem</a>}
      </div>
      <Notice error={f.error} ok={f.ok} />
      {canManage && manual.length > 0 && (
        <div className={`${card} space-y-3`}>
          <h2 className="font-medium">Đổi trạng thái</h2>
          {manual.map((to) => (
            <form key={to} action={change} className="flex flex-wrap gap-2">
              <input type="hidden" name="to" value={to} />
              {NEEDS_REASON.has(to) && <input name="reason" required placeholder="Lý do (bắt buộc)" className={`${input} max-w-sm`} />}
              <button className={btnGhost}>→ {UNIT_STATUS_LABEL[to]}</button>
            </form>
          ))}
        </div>
      )}
      {canManage && ['AVAILABLE', 'RETIRED', 'LOST'].includes(status) && (
        <form action={remove} className={`${card} flex flex-wrap gap-2`}>
          <input name="reason" required placeholder="Lý do xóa" className={`${input} max-w-sm`} />
          <button className={btn}>Xóa thiết bị</button>
        </form>
      )}
      <div className={card}>
        <h2 className="mb-2 font-medium">Lịch sử trạng thái</h2>
        <ul className="space-y-1 text-sm text-slate-700">
          {history.map((h, i) => (
            <li key={i}>{new Date(h.created_at).toLocaleString('vi-VN')} · {h.from_status ? `${UNIT_STATUS_LABEL[h.from_status as UnitStatus]} → ` : ''}{UNIT_STATUS_LABEL[h.to_status as UnitStatus]}{h.reason ? ` · ${h.reason}` : ''}</li>
          ))}
        </ul>
      </div>
      <CustomFieldsPanel entity="UNIT" id={id} back={`/inventory/units/${id}`} />
    </div>
  );
}
