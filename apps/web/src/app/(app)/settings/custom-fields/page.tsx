import Link from 'next/link';
import { FIELD_ENTITIES, FIELD_ENTITY_LABEL, FIELD_KINDS, FIELD_KIND_LABEL, slugifyKey, type FieldEntity, type FieldKind } from '@rentpro/core';
import { createFieldDef, listFieldDefs, updateFieldDef } from '@rentpro/db';
import { Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const BACK = '/settings/custom-fields';
const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const on = (f: FormData, k: string) => f.get(k) === 'on';

async function create(f: FormData) {
  'use server';
  await run(BACK, async () => {
    const label = s(f, 'label');
    await withService((c) => createFieldDef(c, {
      entity: s(f, 'entity') as FieldEntity, kind: s(f, 'kind') as FieldKind, label, key: s(f, 'key') || slugifyKey(label),
      options: s(f, 'options').split('\n').map((x) => x.trim()).filter(Boolean), required: on(f, 'required'), showInList: on(f, 'showInList'), searchable: on(f, 'searchable'), inContract: on(f, 'inContract'),
    }));
    return okUrl(BACK, 'Đã thêm trường tùy chỉnh.');
  });
}

async function update(id: string, f: FormData) {
  'use server';
  await run(BACK, async () => {
    await withService((c) => updateFieldDef(c, id, {
      label: s(f, 'label'), required: on(f, 'required'), showInList: on(f, 'showInList'), searchable: on(f, 'searchable'), inContract: on(f, 'inContract'), active: on(f, 'active'),
      ...(f.has('options') ? { options: s(f, 'options').split('\n').map((x) => x.trim()).filter(Boolean) } : {}),
    }));
    return okUrl(BACK, 'Đã lưu trường.');
  });
}

export default async function CustomFieldsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireAccess('custom_fields', 'settings.manage');
  const f = await searchParams;
  const defs = await withService((c) => listFieldDefs(c, undefined, { includeInactive: true }));
  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Trường tùy chỉnh</h1>
      <Notice error={f.error} ok={f.ok} />
      {FIELD_ENTITIES.map((e) => {
        const list = defs.filter((d) => d.entity === e);
        return (
          <section key={e} className={`${card} space-y-2`} data-testid={`fields-${e}`}>
            <h2 className="font-medium">{FIELD_ENTITY_LABEL[e]}</h2>
            {list.length === 0 ? <p className="text-sm text-slate-500">Chưa có trường nào.</p> : list.map((d) => (
              <form key={d.id} action={update.bind(null, d.id)} className={`flex flex-wrap items-end gap-3 rounded border p-3 text-sm ${d.active ? '' : 'bg-slate-50 opacity-70'}`}>
                <div className="min-w-48 flex-1">
                  <input name="label" defaultValue={d.label} aria-label={`Tên trường ${d.key}`} className={input} />
                  <div className="mt-1 text-xs text-slate-500">mã <code>{d.key}</code> · {FIELD_KIND_LABEL[d.kind]}{d.kind === 'SELECT' ? ` (${d.options.length} lựa chọn)` : ''}</div>
                </div>
                {d.kind === 'SELECT' && <textarea name="options" rows={2} defaultValue={d.options.join('\n')} aria-label={`Lựa chọn ${d.key}`} className={`${input} w-48`} />}
                <label className="flex items-center gap-1"><input type="checkbox" name="required" defaultChecked={d.required} /> Bắt buộc</label>
                {d.kind !== 'FILE' && <label className="flex items-center gap-1"><input type="checkbox" name="showInList" defaultChecked={d.showInList} /> Hiện trong danh sách</label>}
                {['TEXT', 'SELECT', 'NUMBER'].includes(d.kind) && <label className="flex items-center gap-1"><input type="checkbox" name="searchable" defaultChecked={d.searchable} /> Tìm kiếm được</label>}
                {d.kind !== 'FILE' && d.entity !== 'UNIT' && <label className="flex items-center gap-1"><input type="checkbox" name="inContract" defaultChecked={d.inContract} /> Chèn vào hợp đồng</label>}
                <label className="flex items-center gap-1"><input type="checkbox" name="active" defaultChecked={d.active} /> Đang dùng</label>
                <button className={btnGhost}>Lưu</button>
              </form>
            ))}
          </section>
        );
      })}
      <form action={create} className={`${card} space-y-3`} data-testid="field-form">
        <h2 className="font-medium">Thêm trường mới</h2>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Áp dụng cho"><select name="entity" className={input}>{FIELD_ENTITIES.map((e) => <option key={e} value={e}>{FIELD_ENTITY_LABEL[e]}</option>)}</select></Field>
          <Field label="Tên trường (*)"><input name="label" required className={input} placeholder="VD: Biển số xe" /></Field>
          <Field label="Mã (để trống = tự tạo từ tên)"><input name="key" className={input} placeholder="bien_so_xe" /></Field>
          <Field label="Kiểu dữ liệu"><select name="kind" className={input}>{FIELD_KINDS.map((k) => <option key={k} value={k}>{FIELD_KIND_LABEL[k]}</option>)}</select></Field>
        </div>
        <Field label="Lựa chọn (chỉ kiểu &quot;Chọn một&quot;, mỗi dòng một lựa chọn)"><textarea name="options" rows={3} className={input} /></Field>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1"><input type="checkbox" name="required" /> Bắt buộc</label>
          <label className="flex items-center gap-1"><input type="checkbox" name="showInList" /> Hiện trong danh sách</label>
          <label className="flex items-center gap-1"><input type="checkbox" name="searchable" /> Tìm kiếm được</label>
          <label className="flex items-center gap-1"><input type="checkbox" name="inContract" /> Chèn vào hợp đồng (khách / đơn / hợp đồng)</label>
        </div>
        <p className="text-xs text-slate-500">Không đổi được mã và kiểu sau khi tạo. Trường đã có dữ liệu chỉ tắt, không xóa. Tệp đính kèm chỉ nhận ảnh JPG/PNG/WebP và được lưu riêng tư.</p>
        <button className={btn}>Thêm trường</button>
      </form>
    </div>
  );
}
