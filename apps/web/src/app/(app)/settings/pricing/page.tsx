import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getPricingSettings, updatePricingSettings } from '@rentpro/db';
import { DEFAULT_PRICING_CONFIG } from '@rentpro/core';
import { Field, Notice, btn, card, input } from '@/components/ui';
import { run, withService } from '@/lib/service';
import { requireAccess } from '@/lib/session';

export const dynamic = 'force-dynamic';

async function save(form: FormData) {
  'use server';
  await run('/settings/pricing', async () => {
    const lateMode = String(form.get('lateMode'));
    await withService((c) => updatePricingSettings(c, {
      dayMode: String(form.get('dayMode')),
      graceMinutes: Number(form.get('graceMinutes')),
      lateFee: lateMode === 'PER_HOUR' ? { mode: 'PER_HOUR', amount: Number(form.get('lateAmount') || 0) } : { mode: 'PERCENT_OF_DAY', percent: Number(form.get('latePercent') || 0) },
      vatEnabled: form.get('vatEnabled') === 'on',
      vatPercent: Number(form.get('vatPercent') || 0),
      earlyReturn: String(form.get('earlyReturn')),
    }));
    return `/settings/pricing?ok=${encodeURIComponent('Đã lưu quy tắc tính giá.')}`;
  });
}

export default async function PricingSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireAccess('pricing', 'settings.manage');
  const f = await searchParams;
  const cur = await withService((c) => getPricingSettings(c));
  const d = DEFAULT_PRICING_CONFIG;
  const late = cur.lateFee ?? d.lateFee;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/pricing" className="text-sm underline">← Bảng giá</Link>
      <h1 className="text-2xl font-semibold">Quy tắc tính giá</h1>
      <Notice error={f.error} ok={f.ok} />
      <form action={save} className={`${card} space-y-4`}>
        <Field label="Cách tính ngày thuê">
          <select name="dayMode" defaultValue={cur.dayMode ?? d.dayMode} className={input}>
            <option value="ROLLING_24H">Theo mốc 24 giờ kể từ lúc nhận</option>
            <option value="CALENDAR">Theo ngày lịch (chạm ngày nào tính ngày đó)</option>
          </select>
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Ân hạn trả trễ (phút)"><input name="graceMinutes" type="number" min={0} max={1440} defaultValue={cur.graceMinutes ?? d.graceMinutes} className={input} /></Field>
          <Field label="Trả sớm">
            <select name="earlyReturn" defaultValue={cur.earlyReturn ?? d.earlyReturn} className={input}><option value="REFUND_UNUSED">Hoàn phần chưa dùng</option><option value="NO_REFUND">Không hoàn</option></select>
          </Field>
        </div>
        <fieldset className="grid gap-3 rounded border p-3 md:grid-cols-3">
          <legend className="px-1 text-sm text-slate-500">Phí trễ hạn (sau ân hạn)</legend>
          <Field label="Cách tính"><select name="lateMode" defaultValue={late.mode} className={input}><option value="PER_HOUR">Theo giờ (số tiền cố định)</option><option value="PERCENT_OF_DAY">% giá ngày (tỷ lệ theo giờ)</option></select></Field>
          <Field label="VND / giờ"><input name="lateAmount" type="number" min={0} defaultValue={late.mode === 'PER_HOUR' ? late.amount : 0} className={input} /></Field>
          <Field label="% giá ngày"><input name="latePercent" type="number" min={0} max={1000} defaultValue={late.mode === 'PERCENT_OF_DAY' ? late.percent : 100} className={input} /></Field>
        </fieldset>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="vatEnabled" defaultChecked={cur.vatEnabled ?? d.vatEnabled} /> Tính VAT</label>
          <Field label="VAT (%)"><input name="vatPercent" type="number" min={0} max={100} step="0.5" defaultValue={cur.vatPercent ?? d.vatPercent} className={`${input} w-28`} /></Field>
        </div>
        <button className={btn}>Lưu</button>
      </form>
    </div>
  );
}
