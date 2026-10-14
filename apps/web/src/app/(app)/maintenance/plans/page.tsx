import Link from 'next/link';
import { listMaintenancePlans, listModels, planProgress } from '@rentpro/db';
import { Empty, Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { requireAppSession } from '@/lib/session';
import { withService } from '@/lib/service';
import { createPlanAction, togglePlanAction } from '../actions';

export const dynamic = 'force-dynamic';

/** Kế hoạch bảo trì định kỳ: theo số ngày, số giờ đã cho thuê hoặc số lượt thuê — điều kiện nào đến trước thì tạo phiếu. */
export default async function PlansPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const f = await searchParams;
  const sess = await requireAppSession();
  const canManage = sess.permissions.has('maintenance.manage');
  const usage = sess.tenant.features['maintenance.usage_based'];
  const { plans, models, progress } = await withService(async (c) => ({ plans: await listMaintenancePlans(c), models: canManage ? await listModels(c) : [], progress: await planProgress(c) }));
  return (
    <div className="space-y-4">
      <Link href="/maintenance" className="text-sm underline">← Bảo trì</Link>
      <h1 className="text-2xl font-semibold">Kế hoạch bảo trì định kỳ</h1>
      <Notice error={f.error} ok={f.ok} />
      {plans.length === 0 ? <Empty>Chưa có kế hoạch nào.</Empty> : (
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-sm" data-testid="plan-table">
            <thead><tr className="border-b text-left"><th className="py-2">Kế hoạch</th><th>Áp dụng</th><th>Chu kỳ</th><th>Thiết bị gần đến hạn nhất</th><th /></tr></thead>
            <tbody>
              {plans.map((p) => {
                const rows = progress.filter((r) => r.planId === p.id).map((r) => ({ r, pct: Math.max(0, ...Object.values(r.evaluation.progress)) })).sort((a, b) => b.pct - a.pct);
                const top = rows[0];
                return (
                  <tr key={p.id} className={`border-b align-top ${p.active ? '' : 'text-slate-400'}`}>
                    <td className="py-2"><b>{p.name}</b>{!p.active && ' (đã tắt)'}<div className="text-xs">{p.checklist.map((c) => c.text).join(' · ')}</div></td>
                    <td>{p.unitBarcode ? `Chiếc ${p.unitBarcode}` : `Mọi chiếc ${p.modelName}`}</td>
                    <td>{[p.everyDays && `${p.everyDays} ngày`, p.everyHours && `${p.everyHours} giờ thuê`, p.everyRentals && `${p.everyRentals} lượt thuê`].filter(Boolean).join(' · ')}<div className="text-xs text-slate-500">Khung {p.durationHours} giờ</div></td>
                    <td>{top ? <><span className="font-mono">{top.r.barcode}</span> · {Math.round(top.pct * 100)}%{top.r.evaluation.due ? <span className="text-red-700"> · đến hạn</span> : null}</> : '—'}</td>
                    <td>{canManage && <form action={togglePlanAction.bind(null, p.id, !p.active)}><button className="text-xs underline">{p.active ? 'Tắt' : 'Bật'}</button></form>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {canManage && (
        <form action={createPlanAction} className={`${card} space-y-3`} data-testid="plan-form">
          <h2 className="font-medium">Thêm kế hoạch</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Tên (*)"><input name="name" required className={input} placeholder="VD: Vệ sinh cảm biến" /></Field>
            <Field label="Mẫu thiết bị (*)"><select name="modelId" required className={input}>{models.filter((m) => m.tracked).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Mỗi … ngày"><input name="everyDays" type="number" min={1} className={input} /></Field>
            <Field label={`Mỗi … giờ đã thuê${usage ? '' : ' (cần gói cao hơn)'}`}><input name="everyHours" type="number" min={1} disabled={!usage} className={input} /></Field>
            <Field label={`Mỗi … lượt thuê${usage ? '' : ' (cần gói cao hơn)'}`}><input name="everyRentals" type="number" min={1} disabled={!usage} className={input} /></Field>
            <Field label="Khung bảo trì (giờ)"><input name="durationHours" type="number" min={1} max={720} defaultValue={4} className={input} /></Field>
          </div>
          <Field label="Checklist (mỗi dòng một việc)"><textarea name="checklist" rows={3} className={input} /></Field>
          <p className="text-xs text-slate-500">Điều kiện nào đến trước thì hệ thống tạo phiếu và tự xếp khung giờ vào lịch (không trùng đơn đã đặt). Mốc tính từ lần bảo trì hoàn thành gần nhất.</p>
          <button className={btn}>Thêm kế hoạch</button>
        </form>
      )}
      {!canManage && <p className="text-sm text-slate-500">Bạn chỉ có quyền xem kế hoạch.</p>}
      <Link href="/maintenance" className={btnGhost}>Quay lại bảng việc</Link>
    </div>
  );
}
