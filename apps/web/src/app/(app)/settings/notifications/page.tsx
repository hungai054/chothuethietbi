import { CHANNEL_LABEL, DEFAULT_TEMPLATES, NOTIFY_EVENTS, NOTIFY_EVENT_LABEL, TEMPLATE_VARIABLES, type Channel, type NotifyEvent } from '@rentpro/core';
import { getNotifySettings, sendTestNotification, updateNotifySettings } from '@rentpro/db';
import { Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';
import { sharedFromEnv } from '@/lib/notify';

export const dynamic = 'force-dynamic';

const s = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const n = (f: FormData, k: string) => Number(s(f, k));

async function save(f: FormData) {
  'use server';
  await run('/settings/notifications', async () => {
    const templates: Partial<Record<NotifyEvent, string>> = {};
    for (const e of NOTIFY_EVENTS) templates[e] = s(f, `tpl_${e}`);
    const events = Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, f.get(`ev_${e}`) === 'on'])) as Record<NotifyEvent, boolean>;
    await withService((c) => updateNotifySettings(c, {
      channels: (['zalo', 'sms', 'email'] as const).filter((ch) => f.get(`ch_${ch}`) === 'on'),
      quietHours: { enabled: f.get('quietEnabled') === 'on', start: s(f, 'quietStart'), end: s(f, 'quietEnd') },
      reminders: { beforeDueHours: n(f, 'beforeDueHours'), overdueEveryHours: n(f, 'overdueEveryHours'), overdueMax: n(f, 'overdueMax'), holdWarnHours: n(f, 'holdWarnHours'), debtAfterHours: n(f, 'debtAfterHours'), events },
      templates,
      email: { mode: s(f, 'emailMode') as 'console', host: s(f, 'smtpHost'), port: s(f, 'smtpPort') ? n(f, 'smtpPort') : undefined, secure: f.get('smtpSecure') === 'on', user: s(f, 'smtpUser'), from: s(f, 'smtpFrom'), password: s(f, 'smtpPass') },
      sms: { mode: s(f, 'smsMode') as 'console', brandname: s(f, 'smsBrand'), apiKey: s(f, 'smsKey'), secret: s(f, 'smsSecret') },
      zalo: { mode: s(f, 'zaloMode') as 'console', oaId: s(f, 'zaloOa'), templateId: s(f, 'zaloTpl'), accessToken: s(f, 'zaloToken') },
    }));
    return okUrl('/settings/notifications', 'Đã lưu cấu hình thông báo.');
  });
}

async function test(f: FormData) {
  'use server';
  await run('/settings/notifications', async () => {
    const ch = s(f, 'testChannel') as Channel;
    const r = await withService((c) => sendTestNotification(c, ch, s(f, 'testTo'), { shared: sharedFromEnv() }));
    return r.ok ? okUrl('/settings/notifications', r.message) : `/settings/notifications?error=${encodeURIComponent(`Gửi thử thất bại: ${r.message}`)}`;
  });
}

export default async function NotifySettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const sess = await requireAccess('notify.email', 'settings.manage');
  const f = await searchParams;
  const v = await withService((c) => getNotifySettings(c));
  const feat = sess.tenant.features;
  const sel = 'rounded border bg-white px-3 py-2';
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Cấu hình thông báo</h1>
      <Notice error={f.error} ok={f.ok} />
      <form action={save} className="space-y-4" data-testid="notify-settings">
        <section className={`${card} space-y-3`}>
          <h2 className="font-medium">Kênh gửi (theo thứ tự ưu tiên: Zalo → SMS → Email)</h2>
          <p className="text-xs text-slate-500">Hệ thống gửi qua kênh đầu tiên đang bật mà khách có thông tin liên hệ phù hợp.</p>
          {(['zalo', 'sms', 'email'] as const).map((ch) => {
            const allowed = feat[ch === 'zalo' ? 'notify.zalo' : ch === 'sms' ? 'notify.sms' : 'notify.email'];
            return (
              <label key={ch} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={`ch_${ch}`} defaultChecked={v.channels.includes(ch)} disabled={!allowed} /> {CHANNEL_LABEL[ch]}
                {!allowed && <span className="text-xs text-amber-700">(gói hiện tại không có, cần nâng cấp)</span>}
              </label>
            );
          })}
        </section>

        <section className={`${card} space-y-3`}>
          <h2 className="font-medium">Tài khoản gửi</h2>
          <p className="text-xs text-slate-500">Khóa và mật khẩu được mã hóa khi lưu và không hiển thị lại. Để trống ô để giữ giá trị đã lưu. Chế độ &quot;giả lập&quot; chỉ ghi nhật ký, không gửi thật.</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Email"><select name="emailMode" defaultValue={v.email.mode} className={sel}><option value="console">Giả lập</option><option value="smtp">SMTP của cửa hàng</option><option value="shared">Dùng tài khoản chung (tính vào hạn mức)</option></select></Field>
            <Field label="SMTP máy chủ"><input name="smtpHost" defaultValue={v.email.host} className={input} /></Field>
            <Field label="SMTP cổng"><input name="smtpPort" inputMode="numeric" defaultValue={v.email.port} className={input} /></Field>
            <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" name="smtpSecure" defaultChecked={v.email.secure} /> SSL/TLS trực tiếp (cổng 465)</label>
            <Field label="SMTP tài khoản"><input name="smtpUser" defaultValue={v.email.user} className={input} autoComplete="off" /></Field>
            <Field label={`SMTP mật khẩu${v.email.hasPassword ? ' (đã lưu)' : ''}`}><input name="smtpPass" type="password" className={input} autoComplete="new-password" /></Field>
            <Field label="Địa chỉ gửi (From)"><input name="smtpFrom" defaultValue={v.email.from} className={input} /></Field>
          </div>
          <div className="grid gap-3 border-t pt-3 md:grid-cols-2">
            <Field label="SMS"><select name="smsMode" defaultValue={v.sms.mode} className={sel}><option value="console">Giả lập</option><option value="esms">eSMS</option><option value="speedsms">SpeedSMS</option><option value="shared">Dùng tài khoản chung (tính vào hạn mức)</option></select></Field>
            <Field label="Brandname"><input name="smsBrand" defaultValue={v.sms.brandname} className={input} /></Field>
            <Field label={`ApiKey / Access Token${v.sms.hasApiKey ? ' (đã lưu)' : ''}`}><input name="smsKey" type="password" className={input} autoComplete="new-password" /></Field>
            <Field label={`SecretKey (chỉ eSMS)${v.sms.hasSecret ? ' (đã lưu)' : ''}`}><input name="smsSecret" type="password" className={input} autoComplete="new-password" /></Field>
          </div>
          <div className="grid gap-3 border-t pt-3 md:grid-cols-2">
            <Field label="Zalo ZNS"><select name="zaloMode" defaultValue={v.zalo.mode} className={sel}><option value="console">Giả lập</option><option value="zns">Zalo OA của cửa hàng</option><option value="shared">Dùng tài khoản chung (tính vào hạn mức)</option></select></Field>
            <Field label="OA ID"><input name="zaloOa" defaultValue={v.zalo.oaId} className={input} /></Field>
            <Field label="Mã mẫu tin (template ID) đã được Zalo duyệt"><input name="zaloTpl" defaultValue={v.zalo.templateId} className={input} /></Field>
            <Field label={`Access Token${v.zalo.hasToken ? ' (đã lưu)' : ''}`}><input name="zaloToken" type="password" className={input} autoComplete="new-password" /></Field>
          </div>
        </section>

        <section className={`${card} space-y-3`}>
          <h2 className="font-medium">Thời điểm nhắc</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Nhắc trước hạn trả (giờ)"><input name="beforeDueHours" type="number" min={1} max={168} defaultValue={v.reminders.beforeDueHours} className={input} /></Field>
            <Field label="Nhắc lại khi quá hạn, mỗi (giờ)"><input name="overdueEveryHours" type="number" min={1} max={168} defaultValue={v.reminders.overdueEveryHours} className={input} /></Field>
            <Field label="Số lần nhắc quá hạn tối đa"><input name="overdueMax" type="number" min={0} max={30} defaultValue={v.reminders.overdueMax} className={input} /></Field>
            <Field label="Báo giữ chỗ sắp hết hạn trước (giờ)"><input name="holdWarnHours" type="number" min={1} max={72} defaultValue={v.reminders.holdWarnHours} className={input} /></Field>
            <Field label="Nhắc công nợ sau khi nhận lại (giờ)"><input name="debtAfterHours" type="number" min={1} max={720} defaultValue={v.reminders.debtAfterHours} className={input} /></Field>
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            {NOTIFY_EVENTS.map((e) => <label key={e} className="flex items-center gap-2"><input type="checkbox" name={`ev_${e}`} defaultChecked={v.reminders.events[e]} /> {NOTIFY_EVENT_LABEL[e]}</label>)}
          </div>
          <div className="flex flex-wrap items-end gap-3 border-t pt-3 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="quietEnabled" defaultChecked={v.quietHours.enabled} /> Không gửi trong giờ nghỉ</label>
            <Field label="Từ"><input name="quietStart" defaultValue={v.quietHours.start} className={`${input} w-24`} /></Field>
            <Field label="Đến"><input name="quietEnd" defaultValue={v.quietHours.end} className={`${input} w-24`} /></Field>
          </div>
        </section>

        <section className={`${card} space-y-3`}>
          <h2 className="font-medium">Mẫu tin nhắn</h2>
          <p className="text-xs text-slate-500">Biến dùng được: {TEMPLATE_VARIABLES.map((t) => `{${t}}`).join(' ')}. Xóa trống hoặc để nguyên bản mặc định để dùng mẫu chuẩn.</p>
          {NOTIFY_EVENTS.map((e) => (
            <Field key={e} label={`${NOTIFY_EVENT_LABEL[e]}${v.customTemplates.includes(e) ? ' (đã tùy chỉnh)' : ''}`}>
              <textarea name={`tpl_${e}`} rows={3} maxLength={500} defaultValue={v.templates[e] ?? DEFAULT_TEMPLATES[e]} className={input} />
            </Field>
          ))}
        </section>
        <button className={btn}>Lưu cấu hình</button>
      </form>

      <form action={test} className={`${card} flex flex-wrap items-end gap-3`} data-testid="notify-test">
        <h2 className="w-full font-medium">Gửi thử</h2>
        <Field label="Kênh"><select name="testChannel" className={sel}>{(['email', 'sms', 'zalo'] as const).map((ch) => <option key={ch} value={ch}>{CHANNEL_LABEL[ch]}</option>)}</select></Field>
        <Field label="Số điện thoại hoặc email nhận"><input name="testTo" required className={input} /></Field>
        <button className={btnGhost}>Gửi thử</button>
      </form>
    </div>
  );
}
