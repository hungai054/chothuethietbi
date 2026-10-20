import Link from 'next/link';
import { listInbox, markInboxRead } from '@rentpro/db';
import { Empty, btnGhost, card } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { withService } from '@/lib/service';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';

async function markAll() {
  'use server';
  await withService((c) => markInboxRead(c));
  revalidatePath('/inbox');
}

async function markOne(id: string) {
  'use server';
  await withService((c) => markInboxRead(c, id));
  revalidatePath('/inbox');
}

/** Trung tâm thông báo trong app: cảnh báo quá hạn, công nợ, hạn mức tin nhắn… */
const STEP = 50;

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ show?: string; limit?: string }> }) {
  const f = await searchParams;
  const unreadOnly = f.show === 'unread';
  const limit = Math.min(Math.max(Number(f.limit) || STEP, STEP), 200);
  const { items, unread, total, tz } = await withService(async (c, s) => ({ ...(await listInbox(c, limit, { unreadOnly })), tz: s.tenant.timezone }));
  const shown = unreadOnly ? unread : total;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Thông báo {unread > 0 && <span className="text-base font-normal text-slate-500">({unread} chưa đọc)</span>}</h1>
        {unread > 0 && <form action={markAll}><button className={btnGhost}>Đánh dấu đã đọc tất cả</button></form>}
      </div>
      <nav className="flex gap-3 text-sm" aria-label="Lọc thông báo">
        <Link href="/inbox" className={unreadOnly ? 'underline' : 'font-semibold'} data-testid="inbox-all">Tất cả ({total})</Link>
        <Link href="/inbox?show=unread" className={unreadOnly ? 'font-semibold' : 'underline'} data-testid="inbox-unread">Chưa đọc ({unread})</Link>
      </nav>
      {items.length === 0 ? <Empty>{unreadOnly ? 'Không còn thông báo chưa đọc.' : 'Chưa có thông báo nào.'}</Empty> : (
        <ul className="space-y-2" data-testid="inbox-list">
          {items.map((i) => (
            <li key={i.id} className={`${card} flex items-start justify-between gap-3 ${i.read ? 'opacity-60' : 'border-l-4 border-amber-400'}`}>
              <div>
                <div className="font-medium">{i.link ? <Link className="underline" href={i.link}>{i.title}</Link> : i.title}</div>
                {i.body && <div className="text-sm text-slate-600">{i.body}</div>}
                <div className="text-xs text-slate-500">{fmtDateTime(i.createdAt, tz)}</div>
              </div>
              {!i.read && <form action={markOne.bind(null, i.id)}><button className="text-xs underline">Đã đọc</button></form>}
            </li>
          ))}
        </ul>
      )}
      {items.length < shown && limit < 200 && <Link className="text-sm underline" href={`/inbox?${unreadOnly ? 'show=unread&' : ''}limit=${limit + STEP}`} data-testid="inbox-more">Xem thêm</Link>}
    </div>
  );
}
