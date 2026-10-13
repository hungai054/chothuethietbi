import { createUnits, listBranches, listModels } from '@rentpro/db';
import { Field, Notice, btn, card, input } from '@/components/ui';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

async function addUnits(form: FormData) {
  'use server';
  const s = (k: string) => String(form.get(k) ?? '').trim();
  await run('/inventory/units/new', async () => {
    const created = await withService((c) => createUnits(c, {
      modelId: s('modelId'), quantity: Number(s('quantity') || 1), serial: s('serial') || null, barcode: s('barcode') || null,
      branchId: s('branchId') || null, purchaseDate: s('purchaseDate') || null, purchasePrice: s('purchasePrice') ? Number(s('purchasePrice')) : null,
      condition: (s('condition') || 'GOOD') as 'NEW' | 'GOOD' | 'FAIR' | 'POOR',
    }));
    return `/inventory?ok=${encodeURIComponent(`Đã tạo ${created.length} thiết bị: ${created.map((x) => x.barcode).slice(0, 5).join(', ')}${created.length > 5 ? '…' : ''}`)}`;
  });
}

export default async function NewUnit({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const f = await searchParams;
  const { models, branches } = await withService(async (c) => ({
    models: (await listModels(c)).filter((m) => m.tracked), branches: await listBranches(c),
  }));
  return (
    <form action={addUnits} className={`${card} mx-auto max-w-xl space-y-3`}>
      <h1 className="text-xl font-semibold">Thêm thiết bị</h1>
      <Notice error={f.error} />
      {models.length === 0 && <p className="text-sm text-amber-700">Chưa có mẫu quản lý theo từng chiếc. Hãy tạo mẫu trước.</p>}
      <Field label="Mẫu (*)"><select name="modelId" required className={input}>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Số lượng (tạo hàng loạt)"><input name="quantity" type="number" min={1} max={500} defaultValue={1} className={input} /></Field>
        <Field label="Chi nhánh"><select name="branchId" className={input}><option value="">—</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Serial (chỉ khi tạo 1 chiếc)"><input name="serial" className={input} /></Field>
        <Field label="Mã vạch (để trống = tự sinh)"><input name="barcode" className={input} /></Field>
        <Field label="Ngày mua"><input name="purchaseDate" type="date" className={input} /></Field>
        <Field label="Giá nhập (VND)"><input name="purchasePrice" type="number" min={0} className={input} /></Field>
        <Field label="Tình trạng"><select name="condition" defaultValue="GOOD" className={input}><option value="NEW">Mới</option><option value="GOOD">Tốt</option><option value="FAIR">Khá</option><option value="POOR">Kém</option></select></Field>
      </div>
      <button className={btn}>Tạo thiết bị</button>
    </form>
  );
}
