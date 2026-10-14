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
export default async function InboxPage() {
  const { items, unread, tz } = await withService(async (c, s) => ({ ...(await listInbox(c, 50)), tz: s.tenant.timezone }));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Thông báo {unread > 0 && <span className="text-base font-normal text-slate-500">({unread} chưa đọc)</span>}</h1>
        {unread > 0 && <form action={markAll}><button className={btnGhost}>Đánh dấu đã đọc tất cả</button></form>}
      </div>
      {items.length === 0 ? <Empty>Chưa có thông báo nào.</Empty> : (
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
    </div>
  );
}
