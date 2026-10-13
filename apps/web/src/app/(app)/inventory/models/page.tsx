import { createCategory, createModel, listCategoriesFlat, listModels } from '@rentpro/db';
import { UNIT_STATUS_LABEL, type UnitStatus } from '@rentpro/core';
import { Empty, Field, Notice, btn, card, input } from '@/components/ui';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

async function addModel(form: FormData) {
  'use server';
  const num = (k: string) => (String(form.get(k) ?? '').trim() === '' ? null : Number(form.get(k)));
  await run('/inventory/models', async () => {
    await withService((c) => createModel(c, {
      name: String(form.get('name') ?? ''), brand: String(form.get('brand') ?? '') || null, categoryId: String(form.get('categoryId') ?? '') || null,
      barcodePrefix: String(form.get('prefix') ?? '').toUpperCase() || null, bufferMinutes: num('buffer') ?? 0,
      compensationValue: num('compensation'), tracked: form.get('tracked') !== 'qty', stockQty: num('stockQty') ?? 0,
      maintenanceEveryDays: num('everyDays'), maintenanceEveryHours: num('everyHours'), maintenanceEveryRentals: num('everyRentals'),
    }));
    return '/inventory/models?ok=' + encodeURIComponent('Đã tạo mẫu thiết bị.');
  });
}

async function addCategory(form: FormData) {
  'use server';
  await run('/inventory/models', async () => {
    await withService((c) => createCategory(c, { name: String(form.get('name') ?? ''), parentId: String(form.get('parentId') ?? '') || null }));
    return '/inventory/models?ok=' + encodeURIComponent('Đã tạo danh mục.');
  });
}

export default async function ModelsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const f = await searchParams;
  const { models, cats, canManage } = await withService(async (c, s) => ({
    models: await listModels(c), cats: await listCategoriesFlat(c), canManage: s.permissions.has('inventory.manage'),
  }));
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Mẫu thiết bị</h1>
      <Notice error={f.error} ok={f.ok} />
      {models.length === 0 ? <Empty>Chưa có mẫu thiết bị nào.</Empty> : (
        <div className="overflow-x-auto rounded-lg bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-slate-50 text-slate-500"><tr><th className="p-3">Mẫu</th><th>Danh mục</th><th>Loại</th><th>Tổng</th><th>Theo trạng thái</th></tr></thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="p-3 font-medium">{m.name}<div className="text-xs font-normal text-slate-500">{m.brand}</div></td>
                  <td>{m.categoryName ?? '—'}</td>
                  <td>{m.tracked ? 'Theo từng chiếc' : `Theo số lượng (${m.stockQty})`}</td>
                  <td>{m.total}</td>
                  <td className="text-xs text-slate-600">{Object.entries(m.counts).map(([s, n]) => `${UNIT_STATUS_LABEL[s as UnitStatus]}: ${n}`).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && (
        <div className="grid gap-6 md:grid-cols-2">
          <form action={addModel} className={`${card} space-y-3`}>
            <h2 className="font-medium">Thêm mẫu</h2>
            <Field label="Tên mẫu (*)"><input name="name" required className={input} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Hãng"><input name="brand" className={input} /></Field>
              <Field label="Danh mục"><select name="categoryId" className={input}><option value="">—</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Tiền tố mã vạch"><input name="prefix" maxLength={8} pattern="[A-Za-z0-9]{1,8}" placeholder="CAM" className={input} /></Field>
              <Field label="Thời gian đệm (phút)"><input name="buffer" type="number" min={0} defaultValue={0} className={input} /></Field>
              <Field label="Giá trị bồi thường"><input name="compensation" type="number" min={0} className={input} /></Field>
              <Field label="Quản lý"><select name="tracked" className={input}><option value="unit">Từng chiếc (serial, mã vạch)</option><option value="qty">Theo số lượng</option></select></Field>
              <Field label="Tồn (nếu theo số lượng)"><input name="stockQty" type="number" min={0} className={input} /></Field>
            </div>
            <p className="text-xs text-slate-500">Chu kỳ bảo trì (điều kiện nào đến trước):</p>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Ngày"><input name="everyDays" type="number" min={1} className={input} /></Field>
              <Field label="Giờ thuê"><input name="everyHours" type="number" min={1} className={input} /></Field>
              <Field label="Lượt thuê"><input name="everyRentals" type="number" min={1} className={input} /></Field>
            </div>
            <button className={btn}>Tạo mẫu</button>
          </form>
          <form action={addCategory} className={`${card} space-y-3 self-start`}>
            <h2 className="font-medium">Thêm danh mục</h2>
            <Field label="Tên danh mục"><input name="name" required className={input} /></Field>
            <Field label="Danh mục cha"><select name="parentId" className={input}><option value="">— (gốc)</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <button className={btn}>Tạo danh mục</button>
          </form>
        </div>
      )}
    </div>
  );
}
