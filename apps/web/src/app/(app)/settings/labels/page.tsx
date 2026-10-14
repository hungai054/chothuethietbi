import Link from 'next/link';
import { LABEL_DEFAULTS, LABEL_KEYS, LABEL_MAX } from '@rentpro/core';
import { getLabels, updateLabels } from '@rentpro/db';
import { Notice, btn, card, input } from '@/components/ui';
import { okUrl } from '@/lib/forms';
import { requireAccess } from '@/lib/session';
import { run, withService } from '@/lib/service';

export const dynamic = 'force-dynamic';
const BACK = '/settings/labels';

const WHERE: Record<string, string> = {
  unit: 'menu, danh sách và trang chi tiết thiết bị', model: 'menu, trang mẫu thiết bị', customer: 'menu, danh sách khách', booking: 'menu, danh sách đơn',
  contract: 'tên gọi trong giao diện (nội dung hợp đồng sửa ở "Mẫu tài liệu")', deposit: 'menu "Sổ cọc"', maintenance: 'menu và trang bảo trì', pricing: 'menu bảng giá', reports: 'menu báo cáo', timeline: 'menu lịch',
};

async function save(f: FormData) {
  'use server';
  await run(BACK, async () => {
    const input = Object.fromEntries(LABEL_KEYS.map((k) => [k, String(f.get(k) ?? '')]));
    await withService((c) => updateLabels(c, input));
    return okUrl(BACK, 'Đã lưu nhãn.');
  });
}

export default async function LabelsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  await requireAccess('booking', 'settings.manage');
  const f = await searchParams;
  const { labels } = await withService((c) => getLabels(c));
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/settings" className="text-sm underline">← Cài đặt</Link>
      <h1 className="text-2xl font-semibold">Nhãn và thuật ngữ</h1>
      <p className="text-sm text-slate-600">Đổi tên gọi cho hợp với ngành của bạn. Chỉ đổi chữ hiển thị, không ảnh hưởng dữ liệu hay phân quyền. Để trống để dùng tên mặc định.</p>
      <Notice error={f.error} ok={f.ok} />
      <form action={save} className={`${card} space-y-3`} data-testid="labels-form">
        {LABEL_KEYS.map((k) => (
          <label key={k} className="grid items-center gap-2 text-sm md:grid-cols-[12rem_1fr]">
            <span><span className="text-slate-500">Mặc định:</span> {LABEL_DEFAULTS[k]}<span className="block text-xs text-slate-400">{WHERE[k]}</span></span>
            <input name={k} defaultValue={labels[k] === LABEL_DEFAULTS[k] ? '' : labels[k]} placeholder={LABEL_DEFAULTS[k]} maxLength={LABEL_MAX} aria-label={`Nhãn ${LABEL_DEFAULTS[k]}`} className={input} />
          </label>
        ))}
        <button className={btn}>Lưu nhãn</button>
      </form>
    </div>
  );
}
