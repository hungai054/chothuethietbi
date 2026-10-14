import { Scanner } from '@/components/scanner';
import { scanAction } from '../actions';

export const dynamic = 'force-dynamic';

export default function MaintenanceScanPage() {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Quét mã mở phiếu</h1>
      <p className="text-sm text-slate-600">Quét mã thiết bị bằng máy quét USB hoặc camera điện thoại để mở phiếu đang làm, hoặc tạo phiếu mới.</p>
      <Scanner action={scanAction} />
    </div>
  );
}
