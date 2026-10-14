import { getBookingSettings, updateBookingSettings } from '@rentpro/db';
import { requireAccess } from '@/lib/session';
import { DEFAULT_BOOKING_PATTERN, DEFAULT_HOLD_HOURS } from '@rentpro/core';
import { Field, Notice, btn, card, input } from '@/components/ui';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

async function save(form: FormData) {
  'use server';
  await run('/settings/booking', async () => {
    await withService((c) => updateBookingSettings(c, { holdHours: Number(form.get('holdHours')), codePattern: String(form.get('codePattern') ?? '').trim() }));
    return `/settings/booking?ok=${encodeURIComponent('Đã lưu cấu hình đặt lịch.')}`;
  });
}

export default async function BookingSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireAccess('booking', 'settings.manage');
  const f = await searchParams;
  const cur = await withService((c) => getBookingSettings(c));
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Cấu hình đặt lịch</h1>
      <Notice error={f.error} ok={f.ok} />
      <form action={save} className={`${card} space-y-3`}>
        <Field label="Thời gian giữ chỗ (giờ) — hết hạn mà chưa xác nhận thì tự hủy"><input name="holdHours" type="number" min={1} max={720} defaultValue={cur.holdHours ?? DEFAULT_HOLD_HOURS} className={input} /></Field>
        <Field label="Mẫu số đơn thuê (VD DT-{year}-{seq:5})"><input name="codePattern" defaultValue={cur.codePattern ?? DEFAULT_BOOKING_PATTERN} className={input} /></Field>
        <p className="text-xs text-slate-500">Biến hợp lệ: {'{year}'} là năm, {'{seq:N}'} là số thứ tự N chữ số (reset mỗi năm). Chỉ áp dụng cho đơn tạo sau khi đổi.</p>
        <button className={btn}>Lưu</button>
      </form>
    </div>
  );
}
