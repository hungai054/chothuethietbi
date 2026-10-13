import { redirect } from 'next/navigation';
import { Scanner } from '@/components/scanner';
import { requireAppSession } from '@/lib/session';
import { lookupAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function ScanPage() {
  const s = await requireAppSession();
  if (!s.tenant.features['inventory.barcode']) redirect('/inventory?error=' + encodeURIComponent('Gói hiện tại chưa có tính năng quét mã vạch.'));
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Quét mã thiết bị</h1>
      <p className="text-sm text-slate-600">Dùng máy quét USB (con trỏ nằm trong ô bên dưới) hoặc bấm “Camera” trên điện thoại.</p>
      <Scanner action={lookupAction} />
    </div>
  );
}
