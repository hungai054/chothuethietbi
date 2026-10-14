import Link from 'next/link';
import { Resolver } from 'node:dns/promises';
import { addDomain, listDomains, removeDomain, verifyDomain } from '@rentpro/db';
import { Empty, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const BACK = '/settings/domains';
const platformBase = () => process.env.BASE_DOMAIN && process.env.BASE_DOMAIN !== 'localhost' ? process.env.BASE_DOMAIN : undefined;
const cnameTarget = () => process.env.CUSTOM_DOMAIN_TARGET ?? (platformBase() ? `custom.${platformBase()}` : null);
const opts = () => ({ platformBase: platformBase(), cnameTarget: cnameTarget() });

async function add(f: FormData) {
  'use server';
  await run(BACK, async () => { await withService((c) => addDomain(c, String(f.get('domain') ?? ''), opts())); return okUrl(BACK, 'Đã thêm tên miền. Hãy tạo bản ghi DNS theo hướng dẫn rồi bấm "Kiểm tra".'); });
}
async function verify(id: string) {
  'use server';
  await run(BACK, async () => {
    const dns = new Resolver({ timeout: 4000, tries: 1 });
    const r = await withService((c) => verifyDomain(c, id, { resolveTxt: (n) => dns.resolveTxt(n), resolveCname: (n) => dns.resolveCname(n) }, opts()));
    return r.ok ? okUrl(BACK, r.message) : `${BACK}?error=${encodeURIComponent(r.message)}`;
  });
}
async function remove(id: string) {
  'use server';
  await run(BACK, async () => { await withService((c) => removeDomain(c, id)); return okUrl(BACK, 'Đã gỡ tên miền.'); });
}

export default async function DomainsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const sess = await requireAccess('custom_domain', 'settings.manage');
  const q = await searchParams;
  const domains = await withService((c) => listDomains(c));
  const target = cnameTarget();
  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Tên miền riêng</h1>
      <Notice error={q.error} ok={q.ok} />
      <div className={`${card} space-y-1 text-sm`}>
        <p><b>Cách làm:</b></p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Nhập tên miền của bạn (VD <code>thuethietbi.vn</code> hoặc <code>app.cuahang.com</code>).</li>
          <li>Tại nơi quản lý DNS, tạo bản ghi <b>TXT</b> để chứng minh bạn sở hữu tên miền (mã hiện bên dưới sau khi thêm).</li>
          <li>Tạo bản ghi <b>CNAME</b> trỏ tên miền về <code>{target ?? '(quản trị viên chưa cấu hình địa chỉ đích)'}</code>.</li>
          <li>Bấm &quot;Kiểm tra&quot;. DNS có thể mất vài phút đến vài giờ. Chứng chỉ bảo mật (HTTPS) được cấp tự động sau khi xác minh.</li>
        </ol>
      </div>
      {domains.length === 0 ? <Empty>Chưa có tên miền riêng.</Empty> : (
        <ul className="space-y-3" data-testid="domain-list">
          {domains.map((d) => (
            <li key={d.id} className={`${card} space-y-2 text-sm`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-base">{d.domain}</span>
                {d.verified ? <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">Đã xác minh {d.verifiedAt && fmtDateTime(d.verifiedAt, sess.tenant.timezone)}</span> : <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Chờ xác minh</span>}
              </div>
              {!d.verified && (
                <div className="rounded bg-slate-50 p-2 font-mono text-xs" data-testid="dns-records">
                  <div>TXT &nbsp; {d.txtName} &nbsp; → &nbsp; <b>{d.verifyToken}</b></div>
                  {target && <div>CNAME {d.domain} &nbsp; → &nbsp; {target}</div>}
                </div>
              )}
              <div className="flex gap-2">
                {!d.verified && <form action={verify.bind(null, d.id)}><button className={btn}>Kiểm tra</button></form>}
                <form action={remove.bind(null, d.id)}><button className={btnGhost}>Gỡ tên miền</button></form>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form action={add} className={`${card} flex flex-wrap items-end gap-3`} data-testid="domain-form">
        <label className="text-sm">Tên miền<input name="domain" required placeholder="thuethietbi.vn" className={`${input} mt-1`} /></label>
        <button className={btn}>Thêm tên miền</button>
      </form>
    </div>
  );
}
