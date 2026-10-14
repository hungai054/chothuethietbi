import { BANKS, DEFAULT_CONTRACT_PATTERN, DEFAULT_HANDOVER, DEPOSIT_MODES, DEPOSIT_MODE_LABEL, type DepositMode } from '@rentpro/core';
import { getFinanceSettings, updateFinanceSettings } from '@rentpro/db';
import { Field, Notice, btn, card, input } from '@/components/ui';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

async function save(f: FormData) {
  'use server';
  await run('/settings/finance', async () => {
    const mode = s(f, 'depositMode') as DepositMode;
    const value = Number(s(f, 'depositValue').replace(/[.,\s]/g, '') || 0);
    const deposit = mode === 'NONE' ? { mode } : { mode, value };
    const patch = {
      bank: s(f, 'account') ? { bin: s(f, 'bin'), account: s(f, 'account'), accountName: s(f, 'accountName') || undefined } : undefined,
      deposit,
      handover: { requireContract: f.get('requireContract') === 'on', requireDeposit: f.get('requireDeposit') === 'on' },
      contractPattern: s(f, 'contractPattern') || undefined,
      store: { name: s(f, 'storeName'), address: s(f, 'storeAddress'), phone: s(f, 'storePhone'), taxCode: s(f, 'storeTax'), representative: s(f, 'storeRep') },
    };
    await withService((c) => updateFinanceSettings(c, patch));
    return okUrl('/settings/finance', 'Đã lưu cấu hình tài chính.');
  });
}

export default async function FinanceSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireAccess('payments', 'settings.manage');
  const f = await searchParams;
  const cur = await withService((c) => getFinanceSettings(c));
  const dep = cur.deposit ?? { mode: 'NONE' as const };
  const ho = { ...DEFAULT_HANDOVER, ...(cur.handover ?? {}) };
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Cấu hình tài chính và hợp đồng</h1>
      <Notice error={f.error} ok={f.ok} />
      <form action={save} className="space-y-4" data-testid="finance-settings">
        <section className={`${card} space-y-3`}>
          <h2 className="font-medium">Tài khoản nhận tiền (QR chuyển khoản)</h2>
          <Field label="Ngân hàng"><select name="bin" defaultValue={cur.bank?.bin ?? BANKS[0]!.bin} className={input}>{BANKS.map((b) => <option key={b.bin} value={b.bin}>{b.name} ({b.bin})</option>)}</select></Field>
          <Field label="Số tài khoản (để trống = không dùng QR)"><input name="account" inputMode="numeric" defaultValue={cur.bank?.account ?? ''} className={input} /></Field>
          <Field label="Tên chủ tài khoản"><input name="accountName" defaultValue={cur.bank?.accountName ?? ''} className={input} /></Field>
        </section>
        <section className={`${card} space-y-3`}>
          <h2 className="font-medium">Tiền cọc</h2>
          <Field label="Quy tắc gợi ý mức cọc"><select name="depositMode" defaultValue={dep.mode} className={input}>{DEPOSIT_MODES.map((m) => <option key={m} value={m}>{DEPOSIT_MODE_LABEL[m]}</option>)}</select></Field>
          <Field label="Giá trị (đ nếu cố định; % nếu theo phần trăm)"><input name="depositValue" inputMode="decimal" defaultValue={'value' in dep ? dep.value : ''} className={input} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireDeposit" defaultChecked={ho.requireDeposit} /> Phải đủ cọc mới được giao thiết bị</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireContract" defaultChecked={ho.requireContract} /> Phải có hợp đồng đã ký mới được giao thiết bị</label>
        </section>
        <section className={`${card} space-y-3`}>
          <h2 className="font-medium">Thông tin cửa hàng in trên hợp đồng</h2>
          <Field label="Tên cửa hàng / công ty"><input name="storeName" defaultValue={cur.store?.name ?? ''} className={input} /></Field>
          <Field label="Địa chỉ"><input name="storeAddress" defaultValue={cur.store?.address ?? ''} className={input} /></Field>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Điện thoại"><input name="storePhone" defaultValue={cur.store?.phone ?? ''} className={input} /></Field>
            <Field label="Mã số thuế"><input name="storeTax" defaultValue={cur.store?.taxCode ?? ''} className={input} /></Field>
            <Field label="Người đại diện"><input name="storeRep" defaultValue={cur.store?.representative ?? ''} className={input} /></Field>
          </div>
          <Field label="Mẫu số hợp đồng"><input name="contractPattern" defaultValue={cur.contractPattern ?? DEFAULT_CONTRACT_PATTERN} className={input} /></Field>
          <p className="text-xs text-slate-500">Biến: {'{year}'}, {'{seq:N}'}. Chỉ áp dụng cho hợp đồng lập sau khi đổi.</p>
        </section>
        <button className={btn}>Lưu</button>
      </form>
    </div>
  );
}
