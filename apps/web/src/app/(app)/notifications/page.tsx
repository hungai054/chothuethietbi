import Link from 'next/link';
import { CHANNEL_LABEL } from '@rentpro/core';
import { listNotifications, resendNotification } from '@rentpro/db';
import { Empty, Notice, btnGhost, card } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, { label: string; tone: string }> = {
  QUEUED: { label: 'Chờ gửi', tone: 'bg-amber-100 text-amber-800' }, SENT: { label: 'Đã gửi', tone: 'bg-green-100 text-green-800' },
  FAILED: { label: 'Thất bại', tone: 'bg-red-100 text-red-700' }, SKIPPED: { label: 'Bỏ qua', tone: 'bg-slate-100 text-slate-700' },
};

async function resend(id: string) {
  'use server';
  await run('/notifications', async () => { await withService((c) => resendNotification(c, id)); return okUrl('/notifications', 'Đã đưa tin vào hàng đợi gửi lại.'); });
}

/** Nhật ký tin nhắn gửi khách: trạng thái, lỗi, gửi lại thủ công. */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ status?: string; error?: string; ok?: string }> }) {
  const sess = await requireAccess('notify.email', 'notification.view');
  const f = await searchParams;
  const status = f.status && f.status in STATUS ? f.status : undefined;
  const rows = await withService((c) => listNotifications(c, { status, limit: 100 }));
  const canResend = sess.permissions.has('notification.manage');
  const tz = sess.tenant.timezone;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Nhật ký tin nhắn</h1>
        <nav className="flex gap-2 text-sm">
          <Link href="/notifications" className={btnGhost}>Tất cả</Link>
          {Object.entries(STATUS).map(([k, v]) => <Link key={k} href={`/notifications?status=${k}`} className={btnGhost}>{v.label}</Link>)}
        </nav>
      </div>
      <Notice error={f.error} ok={f.ok} />
      {rows.length === 0 ? <Empty>Chưa có tin nhắn nào.</Empty> : (
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-sm" data-testid="notification-table">
            <thead><tr className="border-b text-left"><th className="py-2">Thời gian</th><th>Loại</th><th>Đơn</th><th>Khách</th><th>Kênh</th><th>Nội dung</th><th>Trạng thái</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b align-top">
                  <td className="py-2 whitespace-nowrap">{fmtDateTime(r.createdAt, tz)}</td>
                  <td>{r.eventLabel}</td>
                  <td>{r.bookingId ? <Link className="font-mono underline" href={`/bookings/${r.bookingId}`}>{r.bookingCode}</Link> : '—'}</td>
                  <td>{r.customerName ?? '—'}<div className="text-xs text-slate-500">{r.recipient}</div></td>
                  <td>{CHANNEL_LABEL[r.channel]}{r.scope === 'CONSOLE' ? ' (giả lập)' : r.scope === 'SHARED' ? ' (tk chung)' : ''}</td>
                  <td className="max-w-md">{r.body}{r.error && <div className="text-xs text-red-700">{r.error}</div>}</td>
                  <td><span className={`rounded px-2 py-0.5 text-xs ${STATUS[r.status]?.tone}`}>{STATUS[r.status]?.label}</span>{r.attempts > 1 && <div className="text-xs text-slate-500">{r.attempts} lần thử</div>}</td>
                  <td>{canResend && (r.status === 'FAILED' || r.status === 'SKIPPED') && r.recipient !== '-' && <form action={resend.bind(null, r.id)}><button className="text-xs underline">Gửi lại</button></form>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
