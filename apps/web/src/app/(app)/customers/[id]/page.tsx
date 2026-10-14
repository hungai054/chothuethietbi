import { CustomFieldsPanel } from '@/components/custom-fields';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ID_DOC_LABEL, ID_DOC_TYPES, PRIVACY_CONSENT_VERSION, TRUST_LABEL, type IdDocType } from '@rentpro/core';
import {
  NotFoundError, addIdDocument, anonymizeCustomer, deleteIdDocument, getCustomer, listGroups, revealIdNumber, setBlacklist, updateCustomer,
} from '@rentpro/db';
import { Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { idImageUrl } from '@/lib/files';
import { run, safe, withService } from '@/lib/service';
import { CustomerForm, customerFromForm } from '../customer-form';
import { RevealNumber } from './reveal';

export const dynamic = 'force-dynamic';

const bytes = async (v: FormDataEntryValue | null) => (v instanceof File && v.size > 0 ? { data: new Uint8Array(await v.arrayBuffer()) } : null);

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id } = await params;
  const f = await searchParams;
  const data = await withService(async (c, s) => {
    try {
      return {
        ...(await getCustomer(c, id)), groups: await listGroups(c), tenantId: s.tenant.id,
        canManage: s.permissions.has('customer.manage'), canViewId: s.permissions.has('customer.id_document.view'), canAnon: s.permissions.has('customer.anonymize'),
      };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data) notFound();
  const { customer: c, documents, groups, canManage, canViewId, canAnon, tenantId } = data;
  const back = `/customers/${id}`;
  const anonymized = !!c.anonymizedAt;

  async function save(form: FormData) {
    'use server';
    await run(back, async () => { await withService((s) => updateCustomer(s, id, customerFromForm(form))); return `${back}?ok=${encodeURIComponent('Đã lưu.')}`; });
  }
  async function blacklist(form: FormData) {
    'use server';
    await run(back, async () => {
      const on = form.get('on') === '1';
      await withService((s) => setBlacklist(s, id, on, String(form.get('reason') ?? '')));
      return `${back}?ok=${encodeURIComponent(on ? 'Đã đưa vào danh sách đen.' : 'Đã gỡ khỏi danh sách đen.')}`;
    });
  }
  async function addDoc(form: FormData) {
    'use server';
    await run(back, async () => {
      await withService(async (s) => addIdDocument(s, id, {
        type: String(form.get('type')) as IdDocType, number: String(form.get('number') ?? ''), issuedDate: String(form.get('issuedDate') ?? '') || null,
        issuedPlace: String(form.get('issuedPlace') ?? '') || null, consent: form.get('consent') === 'on', front: await bytes(form.get('front')), back: await bytes(form.get('back')),
      }));
      return `${back}?ok=${encodeURIComponent('Đã lưu giấy tờ.')}`;
    });
  }
  async function removeDoc(form: FormData) {
    'use server';
    await run(back, async () => { await withService((s) => deleteIdDocument(s, String(form.get('docId')))); return `${back}?ok=${encodeURIComponent('Đã xóa giấy tờ.')}`; });
  }
  async function anonymize() {
    'use server';
    await run(back, async () => { await withService((s) => anonymizeCustomer(s, id)); return `/customers?ok=${encodeURIComponent('Đã ẩn danh khách hàng.')}`; });
  }
  async function reveal(docId: string) {
    'use server';
    const r = await safe(() => withService((s) => revealIdNumber(s, docId)));
    return r.ok ? { ok: true as const, number: r.data } : { ok: false as const, error: r.error };
  }

  return (
    <div className="space-y-4">
      <Link href="/customers" className="text-sm underline">← Khách hàng</Link>
      <h1 className="text-2xl font-semibold">{c.name} {c.blacklisted && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-sm font-normal text-red-700">Danh sách đen</span>}</h1>
      <p className="text-sm text-slate-600">{c.phone}{c.email ? ` · ${c.email}` : ''} · {TRUST_LABEL[c.trustLevel]}{c.groupName ? ` · ${c.groupName}` : ''}</p>
      <Notice error={f.error} ok={f.ok} />
      {c.blacklisted && <p className="rounded bg-red-50 p-3 text-sm text-red-800">Lý do: {c.blacklistReason}</p>}

      {anonymized ? <p className="rounded bg-slate-100 p-4 text-sm">Khách hàng này đã được ẩn danh theo yêu cầu. Chỉ còn lại dữ liệu đơn thuê để đối soát.</p> : (
        <>
          {canManage && <CustomerForm action={save} groups={groups} submit="Lưu thay đổi" initial={{ ...c, email: c.email ?? '', address: c.address ?? '', zalo: c.zalo ?? '', companyName: c.companyName ?? '', taxCode: c.taxCode ?? '', representative: c.representative ?? '', notes: c.notes ?? '', groupId: c.groupId ?? '' }} />}

          <CustomFieldsPanel entity="CUSTOMER" id={id} back={back} />

          <section className={`${card} space-y-3`} aria-labelledby="docs">
            <h2 id="docs" className="font-medium">Giấy tờ tùy thân</h2>
            {documents.length === 0 && <p className="text-sm text-slate-500">Chưa có giấy tờ.</p>}
            <ul className="space-y-2 text-sm">
              {documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 rounded border p-3">
                  <b>{ID_DOC_LABEL[d.type]}</b>
                  {canViewId ? <RevealNumber action={reveal.bind(null, d.id)} last4={d.last4} /> : <span className="font-mono" data-testid="id-number">••••{d.last4}</span>}
                  <span className="text-slate-500">{d.issuedDate ?? ''} {d.issuedPlace ?? ''}</span>
                  <span className="text-xs text-slate-500">Đồng ý xử lý dữ liệu ({d.consentVersion}) lúc {new Date(d.consentAt).toLocaleString('vi-VN')}</span>
                  {canViewId && d.hasFront && <a className="underline" target="_blank" rel="noopener" href={idImageUrl(tenantId, d.id, 'front')}>Ảnh mặt trước</a>}
                  {canViewId && d.hasBack && <a className="underline" target="_blank" rel="noopener" href={idImageUrl(tenantId, d.id, 'back')}>Ảnh mặt sau</a>}
                  {canManage && <form action={removeDoc} className="ml-auto"><input type="hidden" name="docId" value={d.id} /><button className="text-red-700 underline">Xóa</button></form>}
                </li>
              ))}
            </ul>
            {!canViewId && documents.length > 0 && <p className="text-xs text-slate-500">Bạn không có quyền xem số và ảnh giấy tờ.</p>}

            {canManage && (
              <form action={addDoc} className="space-y-3 border-t pt-3" encType="multipart/form-data">
                <h3 className="text-sm font-medium">Thêm giấy tờ</h3>
                <div className="grid gap-3 md:grid-cols-4">
                  <Field label="Loại"><select name="type" className={input}>{ID_DOC_TYPES.map((t) => <option key={t} value={t}>{ID_DOC_LABEL[t]}</option>)}</select></Field>
                  <Field label="Số giấy tờ (*)"><input name="number" required className={input} autoComplete="off" /></Field>
                  <Field label="Ngày cấp"><input name="issuedDate" type="date" className={input} /></Field>
                  <Field label="Nơi cấp"><input name="issuedPlace" className={input} /></Field>
                  <Field label="Ảnh mặt trước"><input name="front" type="file" accept="image/jpeg,image/png,image/webp" className="w-full text-sm" /></Field>
                  <Field label="Ảnh mặt sau"><input name="back" type="file" accept="image/jpeg,image/png,image/webp" className="w-full text-sm" /></Field>
                </div>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="consent" className="mt-1" />
                  <span>Khách đã đồng ý cho cửa hàng thu thập và xử lý dữ liệu cá nhân theo Nghị định 13/2023/NĐ-CP (phiên bản điều khoản {PRIVACY_CONSENT_VERSION}).</span></label>
                <button className={btn}>Lưu giấy tờ</button>
              </form>
            )}
          </section>

          {canManage && (
            <section className={`${card} space-y-3`}>
              <h2 className="font-medium">Danh sách đen</h2>
              {c.blacklisted ? (
                <form action={blacklist}><input type="hidden" name="on" value="0" /><button className={btnGhost}>Gỡ khỏi danh sách đen</button></form>
              ) : (
                <form action={blacklist} className="flex flex-wrap gap-2"><input type="hidden" name="on" value="1" />
                  <input name="reason" required placeholder="Lý do (bắt buộc)" className={`${input} max-w-sm`} /><button className={btnGhost}>Đưa vào danh sách đen</button></form>
              )}
            </section>
          )}

          {canAnon && (
            <section className={`${card} space-y-2`}>
              <h2 className="font-medium">Ẩn danh theo yêu cầu của khách</h2>
              <p className="text-sm text-slate-600">Xóa họ tên, liên hệ, giấy tờ và ảnh. Không thể khôi phục. Đơn thuê cũ được giữ để đối soát.</p>
              <form action={anonymize} className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" required /> Tôi hiểu thao tác này không thể hoàn tác</label>
                <button className="rounded bg-red-700 px-4 py-2 text-white">Ẩn danh khách hàng này</button></form>
            </section>
          )}
        </>
      )}
    </div>
  );
}
