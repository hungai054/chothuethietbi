import type { ReactNode } from 'react';
import { TRUST_LABEL, TRUST_LEVELS, type CustomerInput } from '@rentpro/core';
import { Field, btn, card, input } from '@/components/ui';

type Initial = Partial<Pick<CustomerInput, 'type' | 'name' | 'phone' | 'email' | 'address' | 'zalo' | 'companyName' | 'taxCode' | 'representative' | 'trustLevel' | 'groupId' | 'notes'>>;

/** Form dùng chung cho tạo và sửa khách hàng (server action truyền từ trang). */
export function CustomerForm({ action, initial = {}, groups, submit, extra }: { action: (f: FormData) => Promise<void>; initial?: Initial; groups: { id: string; name: string }[]; submit: string; extra?: ReactNode }) {
  return (
    <form action={action} className={`${card} space-y-3`}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Loại khách"><select name="type" defaultValue={initial.type ?? 'PERSON'} className={input}><option value="PERSON">Cá nhân</option><option value="COMPANY">Doanh nghiệp</option></select></Field>
        <Field label="Nhóm khách"><select name="groupId" defaultValue={initial.groupId ?? ''} className={input}><option value="">— Khách lẻ</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
        <Field label="Họ tên (*)"><input name="name" required defaultValue={initial.name} className={input} /></Field>
        <Field label="Số điện thoại (*)"><input name="phone" required defaultValue={initial.phone} placeholder="0901 234 567" className={input} /></Field>
        <Field label="Email"><input name="email" type="email" defaultValue={initial.email} className={input} /></Field>
        <Field label="Zalo"><input name="zalo" defaultValue={initial.zalo} className={input} /></Field>
        <Field label="Địa chỉ"><input name="address" defaultValue={initial.address} className={input} /></Field>
        <Field label="Mức tin cậy"><select name="trustLevel" defaultValue={initial.trustLevel ?? 'NEW'} className={input}>{TRUST_LEVELS.map((t) => <option key={t} value={t}>{TRUST_LABEL[t]}</option>)}</select></Field>
      </div>
      <fieldset className="grid gap-3 rounded border p-3 md:grid-cols-3">
        <legend className="px-1 text-sm text-slate-500">Khách doanh nghiệp</legend>
        <Field label="Tên công ty"><input name="companyName" defaultValue={initial.companyName} className={input} /></Field>
        <Field label="Mã số thuế"><input name="taxCode" defaultValue={initial.taxCode} className={input} /></Field>
        <Field label="Người đại diện"><input name="representative" defaultValue={initial.representative} className={input} /></Field>
      </fieldset>
      <Field label="Ghi chú"><textarea name="notes" rows={2} defaultValue={initial.notes} className={input} /></Field>
      {extra}
      <button className={btn}>{submit}</button>
    </form>
  );
}

export const customerFromForm = (f: FormData) => Object.fromEntries(['type', 'name', 'phone', 'email', 'address', 'zalo', 'companyName', 'taxCode', 'representative', 'trustLevel', 'groupId', 'notes'].map((k) => [k, String(f.get(k) ?? '')]));
