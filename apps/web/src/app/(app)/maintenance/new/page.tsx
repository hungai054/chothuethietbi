import Link from 'next/link';
import { ORDER_KINDS, ORDER_KIND_LABEL } from '@rentpro/core';
import { listTechnicians, listUnits } from '@rentpro/db';
import { Field, Notice, btn, card, input } from '@/components/ui';
import { requireAccess } from '@/lib/session';
import { withService } from '@/lib/service';
import { createOrderAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<{ unit?: string; error?: string }> }) {
  await requireAccess('maintenance', 'maintenance.manage');
  const f = await searchParams;
  const { units, techs } = await withService(async (c) => ({ units: (await listUnits(c, { pageSize: 200 })).rows.filter((u) => !['RETIRED', 'LOST'].includes(u.status)), techs: await listTechnicians(c) }));
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/maintenance" className="text-sm underline">← Bảo trì</Link>
      <h1 className="text-2xl font-semibold">Tạo phiếu bảo trì / sửa chữa</h1>
      <Notice error={f.error} />
      <form action={createOrderAction} className={`${card} space-y-3`} data-testid="order-form">
        <Field label="Thiết bị (*)">
          <select name="unitId" required defaultValue={f.unit ?? ''} className={input}>
            <option value="" disabled>— Chọn thiết bị —</option>
            {units.map((u) => <option key={u.id} value={u.id}>{u.barcode} · {u.modelName}</option>)}
          </select>
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Loại"><select name="kind" className={input}>{ORDER_KINDS.map((k) => <option key={k} value={k}>{ORDER_KIND_LABEL[k]}</option>)}</select></Field>
          <Field label="Hạn hoàn thành"><input name="dueDate" type="date" className={input} /></Field>
        </div>
        <Field label="Tiêu đề (*)"><input name="title" required className={input} placeholder="VD: Thay màn hình LCD" /></Field>
        <Field label="Mô tả"><textarea name="description" rows={3} className={input} /></Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Kỹ thuật viên"><select name="technicianId" className={input}><option value="">— Chưa giao —</option>{techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Đơn vị sửa ngoài (nếu có)"><input name="vendor" className={input} /></Field>
        </div>
        <Field label="Checklist (mỗi dòng một việc)"><textarea name="checklist" rows={3} className={input} placeholder={'Vệ sinh cảm biến\nKiểm tra nút bấm'} /></Field>
        <fieldset className="rounded border p-3">
          <legend className="px-1 text-sm text-slate-600">Giữ lịch (tùy chọn): chiếc này sẽ không nhận đơn thuê trong khung giờ này</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Từ"><input name="windowStart" type="datetime-local" className={input} /></Field>
            <Field label="Đến"><input name="windowEnd" type="datetime-local" className={input} /></Field>
          </div>
        </fieldset>
        <button className={btn}>Tạo phiếu</button>
      </form>
    </div>
  );
}
