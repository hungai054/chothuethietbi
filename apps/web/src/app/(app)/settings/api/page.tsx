import Link from 'next/link';
import { API_SCOPES, API_SCOPE_LABEL, WEBHOOK_EVENTS, WEBHOOK_EVENT_LABEL } from '@rentpro/core';
import { deleteWebhook, listApiKeys, listDeliveries, listWebhooks, redeliver, revokeApiKey, setWebhookActive } from '@rentpro/db';
import { Empty, Notice, btnGhost, card } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';
import { KeyForm, RotateButton, WebhookForm } from './forms';

export const dynamic = 'force-dynamic';
const BACK = '/settings/api';

async function revoke(id: string) {
  'use server';
  await run(BACK, async () => { await withService((c) => revokeApiKey(c, id)); return okUrl(BACK, 'Đã thu hồi khóa API.'); });
}
async function toggle(id: string, active: boolean) {
  'use server';
  await run(BACK, async () => { await withService((c) => setWebhookActive(c, id, active)); return okUrl(BACK, active ? 'Đã bật webhook.' : 'Đã tạm dừng webhook.'); });
}
async function remove(id: string) {
  'use server';
  await run(BACK, async () => { await withService((c) => deleteWebhook(c, id)); return okUrl(BACK, 'Đã xóa webhook.'); });
}
async function retry(id: string) {
  'use server';
  await run(BACK, async () => { await withService((c) => redeliver(c, id)); return okUrl(BACK, 'Đã xếp lại để gửi.'); });
}

const STATUS_VI: Record<string, string> = { PENDING: 'Chờ gửi', SENT: 'Đã gửi', FAILED: 'Thất bại' };

export default async function ApiSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const sess = await requireAccess('api', 'settings.manage');
  const q = await searchParams;
  const tz = sess.tenant.timezone;
  const { keys, hooks, deliveries } = await withService(async (c) => ({ keys: await listApiKeys(c), hooks: await listWebhooks(c), deliveries: await listDeliveries(c, { limit: 30 }) }));
  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">API và webhook</h1>
      <Notice error={q.error} ok={q.ok} />
      <div className={`${card} space-y-1 text-sm`}>
        <p>Dùng khóa API để website/ứng dụng của bạn tra cứu thiết bị còn trống, tạo khách và tạo đơn thuê. Gửi header <code>Authorization: Bearer rp_live_…</code> tới <code>/api/v1/…</code>.</p>
        <p>Tài liệu OpenAPI: <a className="underline" href="/api/v1/openapi.json">/api/v1/openapi.json</a>. Khóa không bao giờ truy cập được giấy tờ tùy thân, tiền cọc hay cài đặt.</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Khóa API</h2>
        {keys.length === 0 ? <Empty>Chưa có khóa API.</Empty> : (
          <ul className="space-y-2" data-testid="key-list">
            {keys.map((k) => (
              <li key={k.id} className={`${card} flex flex-wrap items-center justify-between gap-2 text-sm`}>
                <div>
                  <div className="font-medium">{k.name} <code className="ml-1 text-xs text-slate-500">{k.prefix}…</code>
                    {k.revokedAt && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">Đã thu hồi</span>}</div>
                  <div className="text-slate-600">{k.scopes.join(', ')}</div>
                  <div className="text-xs text-slate-500">Tạo {fmtDateTime(k.createdAt, tz)} · Dùng gần nhất: {k.lastUsedAt ? fmtDateTime(k.lastUsedAt, tz) : 'chưa dùng'}{k.expiresAt && ` · Hết hạn ${fmtDateTime(k.expiresAt, tz)}`}</div>
                </div>
                {!k.revokedAt && <form action={revoke.bind(null, k.id)}><button className={btnGhost}>Thu hồi</button></form>}
              </li>
            ))}
          </ul>
        )}
        <KeyForm scopes={API_SCOPES.map((s) => ({ value: s, label: API_SCOPE_LABEL[s] }))} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Webhook</h2>
        <p className="text-sm text-slate-600">Hệ thống gửi POST JSON kèm chữ ký <code>X-RentPro-Signature</code> (HMAC-SHA256) mỗi khi có sự kiện; lỗi sẽ được thử lại tối đa 6 lần.</p>
        {hooks.length === 0 ? <Empty>Chưa có địa chỉ nhận webhook.</Empty> : (
          <ul className="space-y-2" data-testid="webhook-list">
            {hooks.map((h) => (
              <li key={h.id} className={`${card} space-y-2 text-sm`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all font-mono">{h.url}</span>
                  {h.active ? <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">Đang bật</span>
                    : <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Tạm dừng{h.disabledReason ? `: ${h.disabledReason}` : ''}</span>}
                </div>
                {h.description && <div className="text-slate-600">{h.description}</div>}
                <div className="text-xs text-slate-500">{h.events.join(', ')}{h.consecutiveFailures > 0 && ` · ${h.consecutiveFailures} lần lỗi liên tiếp`}</div>
                <div className="flex flex-wrap items-start gap-2">
                  <form action={toggle.bind(null, h.id, !h.active)}><button className={btnGhost}>{h.active ? 'Tạm dừng' : 'Bật lại'}</button></form>
                  <RotateButton id={h.id} />
                  <form action={remove.bind(null, h.id)}><button className={btnGhost}>Xóa</button></form>
                </div>
              </li>
            ))}
          </ul>
        )}
        <WebhookForm events={WEBHOOK_EVENTS.map((e) => ({ value: e, label: WEBHOOK_EVENT_LABEL[e] }))} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Nhật ký gửi gần đây</h2>
        {deliveries.length === 0 ? <Empty>Chưa có lần gửi nào.</Empty> : (
          <div className={`${card} overflow-x-auto`}>
            <table className="w-full text-sm" data-testid="delivery-list">
              <thead><tr className="text-left text-slate-500"><th className="p-1">Thời gian</th><th className="p-1">Sự kiện</th><th className="p-1">Trạng thái</th><th className="p-1">Lần</th><th className="p-1">Kết quả</th><th /></tr></thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-t">
                    <td className="p-1">{fmtDateTime(d.createdAt, tz)}</td><td className="p-1"><code>{d.event}</code></td><td className="p-1">{STATUS_VI[d.status] ?? d.status}</td>
                    <td className="p-1">{d.attempts}</td><td className="p-1 text-xs">{d.lastStatus ?? ''} {d.lastError ?? ''}</td>
                    <td className="p-1">{d.status === 'FAILED' && <form action={retry.bind(null, d.id)}><button className={btnGhost}>Gửi lại</button></form>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
