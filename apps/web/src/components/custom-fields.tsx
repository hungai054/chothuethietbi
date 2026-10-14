import type { FieldDef, FieldEntity } from '@rentpro/core';
import { FIELD_ENTITY_LABEL, formatFieldValue } from '@rentpro/core';
import { customValuesFor, listFieldDefs } from '@rentpro/db';
import { Field, btnGhost, card, input } from '@/components/ui';
import { withService } from '@/lib/service';
import { requireAppSession } from '@/lib/session';
import { saveCustomFieldsAction } from '@/app/(app)/custom-fields-actions';

type Def = FieldDef & { id?: string };
type Values = Record<string, unknown>;

/**
 * Ô nhập các trường tùy chỉnh (trừ tệp đính kèm) để nhúng vào form tạo/sửa.
 * `booleanAsSelect`: dùng cho form gửi bằng GET (ô tích bỏ chọn sẽ không gửi gì), nên hiện dạng chọn Có/Không.
 */
export function CustomFieldInputs({ defs, values = {}, booleanAsSelect = false, defaults = {} }: { defs: Def[]; values?: Values; booleanAsSelect?: boolean; defaults?: Record<string, string | undefined> }) {
  const shown = defs.filter((d) => d.kind !== 'FILE');
  if (shown.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="custom-field-inputs">
      {shown.map((d) => {
        const name = `cf_${d.key}`;
        const cur = values[d.key];
        const dv = defaults[name];
        const label = `${d.label}${d.required ? ' (*)' : ''}`;
        switch (d.kind) {
          case 'SELECT':
            return <Field key={d.key} label={label}><select name={name} defaultValue={dv ?? String(cur ?? '')} className={input}><option value="">—</option>{d.options.map((o) => <option key={o} value={o}>{o}</option>)}</select></Field>;
          case 'BOOLEAN':
            return booleanAsSelect
              ? <Field key={d.key} label={label}><select name={name} defaultValue={dv ?? (cur === true ? 'true' : cur === false ? 'false' : '')} className={input}><option value="">—</option><option value="true">Có</option><option value="false">Không</option></select></Field>
              : <label key={d.key} className="flex items-center gap-2 pt-6 text-sm"><input type="hidden" name={`cfb_${d.key}`} value="1" /><input type="checkbox" name={name} defaultChecked={cur === true} /> {label}</label>;
          case 'DATE':
            return <Field key={d.key} label={label}><input name={name} type="date" defaultValue={dv ?? String(cur ?? '')} className={input} /></Field>;
          case 'NUMBER':
            return <Field key={d.key} label={label}><input name={name} inputMode="decimal" defaultValue={dv ?? (typeof cur === 'number' ? String(cur) : '')} className={input} /></Field>;
          default:
            return <Field key={d.key} label={label}><input name={name} defaultValue={dv ?? String(cur ?? '')} maxLength={500} className={input} /></Field>;
        }
      })}
    </div>
  );
}

/** Khung "Trường tùy chỉnh" cho trang chi tiết: hiện giá trị, cho sửa (nếu có quyền) và đính kèm tệp. Tự ẩn khi không có trường nào. */
const WRITE_PERM = { UNIT: 'inventory.manage', CUSTOMER: 'customer.manage', BOOKING: 'booking.create', CONTRACT: 'contract.create' } as const;

export async function CustomFieldsPanel({ entity, id, back }: { entity: FieldEntity; id: string; back: string }) {
  const canEdit = (await requireAppSession()).permissions.has(WRITE_PERM[entity]);
  const { defs, values } = await withService(async (c) => ({ defs: await listFieldDefs(c, entity), values: (await customValuesFor(c, entity, [id])).get(id) ?? {} }));
  if (defs.length === 0) return null;
  const files = defs.filter((d) => d.kind === 'FILE');
  return (
    <section className={`${card} space-y-3`} data-testid="custom-fields-panel">
      <h2 className="font-medium">Trường tùy chỉnh · {FIELD_ENTITY_LABEL[entity]}</h2>
      {canEdit ? (
        <form action={saveCustomFieldsAction.bind(null, entity, id, back)} className="space-y-3" encType="multipart/form-data">
          <CustomFieldInputs defs={defs} values={values} />
          {files.map((d) => {
            const v = values[d.key] as { name?: string } | undefined;
            return (
              <div key={d.key} className="text-sm">
                <div className="mb-1 text-slate-600">{d.label}</div>
                {v?.name && <p className="mb-1"><a className="underline" href={`/media/field-${entity.toLowerCase()}/${id}/${d.key}`}>{v.name}</a> <label className="ml-3 text-xs"><input type="checkbox" name={`cfdel_${d.key}`} /> Gỡ tệp</label></p>}
                <input name={`cffile_${d.key}`} type="file" accept="image/png,image/jpeg,image/webp" className={`${input} max-w-sm`} />
              </div>
            );
          })}
          <button className={btnGhost}>Lưu trường tùy chỉnh</button>
        </form>
      ) : (
        <dl className="grid gap-2 text-sm md:grid-cols-2">{defs.map((d) => <div key={d.key}><dt className="text-slate-500">{d.label}</dt><dd>{formatFieldValue(d, values[d.key]) || '—'}</dd></div>)}</dl>
      )}
    </section>
  );
}
