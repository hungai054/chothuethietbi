import Link from 'next/link';
import { redirect } from 'next/navigation';
import { DOC_VARIABLES, DOC_VARIABLE_LABEL } from '@rentpro/core';
import { getDocTemplates, listFieldDefs, previewContract, updateDocTemplates } from '@rentpro/db';
import { ContractDocument } from '@/components/contract-document';
import { Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { isUserError, run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const BACK = '/settings/templates';
const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const terms = (f: FormData) => s(f, 'terms').split('\n').map((x) => x.trim()).filter(Boolean);

async function saveContract(f: FormData) {
  'use server';
  await run(BACK, async () => { await withService((c) => updateDocTemplates(c, { contract: { title: s(f, 'title'), terms: terms(f) } })); return okUrl(BACK, 'Đã lưu mẫu hợp đồng. Hợp đồng lập từ giờ sẽ dùng mẫu này.'); });
}
async function resetContract() {
  'use server';
  await run(BACK, async () => { await withService((c) => updateDocTemplates(c, { contract: null })); return okUrl(BACK, 'Đã quay về mẫu hợp đồng mặc định.'); });
}
async function saveSimple(kind: 'receipt' | 'handover', f: FormData) {
  'use server';
  await run(BACK, async () => { await withService((c) => updateDocTemplates(c, { [kind]: { title: s(f, 'title'), footer: s(f, 'footer') } })); return okUrl(BACK, kind === 'receipt' ? 'Đã lưu mẫu phiếu thu.' : 'Đã lưu mẫu biên bản.'); });
}
async function resetSimple(kind: 'receipt' | 'handover') {
  'use server';
  await run(BACK, async () => { await withService((c) => updateDocTemplates(c, { [kind]: null })); return okUrl(BACK, 'Đã quay về mẫu mặc định.'); });
}
/** Xem trước bản đang soạn: đưa nội dung vào địa chỉ để trang dựng lại, không lưu gì. */
async function preview(f: FormData) {
  'use server';
  const p = new URLSearchParams({ pt: s(f, 'title'), pb: terms(f).join('\n') });
  redirect(`${BACK}?${p}#preview`);
}

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string; pt?: string; pb?: string }> }) {
  await requireAccess('contract', 'settings.manage');
  const q = await searchParams;
  const data = await withService(async (c) => {
    const t = await getDocTemplates(c);
    const keys = (await listFieldDefs(c)).map((d) => ({ key: d.key, label: d.label, entity: d.entity }));
    let pv = null;
    let pvError = '';
    try {
      pv = await previewContract(c, q.pt !== undefined ? { title: q.pt || 'HỢP ĐỒNG', terms: (q.pb ?? '').split('\n').filter(Boolean) } : undefined);
    } catch (e) {
      if (!isUserError(e)) throw e;
      pvError = e.message;
    }
    return { t, keys, pv, pvError };
  });
  const { resolved: r, custom } = data.t;
  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Mẫu tài liệu</h1>
      <Notice error={q.error || data.pvError} ok={q.ok} />
      <p className="rounded bg-slate-100 p-3 text-xs text-slate-600" data-testid="template-vars">
        Biến dùng trong nội dung: {DOC_VARIABLES.map((v) => <code key={v} className="mr-2" title={DOC_VARIABLE_LABEL[v]}>{`{${v}}`}</code>)}
        {data.keys.map((k) => <code key={`${k.entity}${k.key}`} className="mr-2" title={k.label}>{`{cf.${k.key}}`}</code>)}
        <br />Hợp đồng đã lập không đổi khi bạn sửa mẫu; mẫu mới chỉ áp dụng cho hợp đồng lập sau.
      </p>

      <form className={`${card} space-y-3`} data-testid="contract-template">
        <h2 className="font-medium">Hợp đồng {custom.contract ? <span className="text-xs text-green-700">(đã tùy chỉnh)</span> : <span className="text-xs text-slate-500">(mặc định)</span>}</h2>
        <Field label="Tiêu đề"><input name="title" defaultValue={q.pt ?? r.contract.title} className={input} /></Field>
        <Field label="Điều khoản (mỗi dòng một điều khoản)"><textarea name="terms" rows={10} defaultValue={q.pb ?? r.contract.terms.join('\n')} className={`${input} font-mono text-sm`} /></Field>
        <div className="flex flex-wrap gap-2">
          <button formAction={saveContract} className={btn}>Lưu mẫu hợp đồng</button>
          <button formAction={preview} className={btnGhost}>Xem trước bản đang soạn</button>
          <button formAction={resetContract} className={btnGhost}>Về mặc định</button>
        </div>
      </form>

      {(['receipt', 'handover'] as const).map((k) => (
        <form key={k} className={`${card} space-y-3`} data-testid={`${k}-template`}>
          <h2 className="font-medium">{k === 'receipt' ? 'Phiếu thu' : 'Biên bản giao nhận'} {custom[k] ? <span className="text-xs text-green-700">(đã tùy chỉnh)</span> : <span className="text-xs text-slate-500">(mặc định)</span>}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Tiêu đề"><input name="title" defaultValue={r[k].title} className={input} /></Field>
            <Field label="Chân trang (lời cảm ơn, hotline…)"><input name="footer" defaultValue={r[k].footer} className={input} /></Field>
          </div>
          <div className="flex gap-2">
            <button formAction={saveSimple.bind(null, k)} className={btn}>Lưu</button>
            <button formAction={resetSimple.bind(null, k)} className={btnGhost}>Về mặc định</button>
          </div>
        </form>
      ))}

      {data.pv && (
        <section id="preview" className="space-y-2" data-testid="contract-preview">
          <h2 className="font-medium">Xem trước hợp đồng {q.pt !== undefined ? '(bản đang soạn, chưa lưu)' : '(mẫu đang dùng)'} với dữ liệu mẫu</h2>
          <div className="mx-auto max-w-3xl space-y-4 bg-white p-8 text-[15px] leading-relaxed shadow-sm"><ContractDocument c={data.pv} /></div>
        </section>
      )}
    </div>
  );
}
