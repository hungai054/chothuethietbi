import { redirect } from 'next/navigation';
import { requireAppSession } from '@/lib/session';
import { ImportForm } from './import-form';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const s = await requireAppSession();
  if (!s.permissions.has('inventory.manage')) redirect('/inventory?error=' + encodeURIComponent('Bạn không có quyền nhập thiết bị.'));
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Nhập thiết bị từ Excel</h1>
      <p className="text-sm text-slate-600">
        Tải <a className="underline" href="/inventory/import/template">file mẫu</a>, điền dữ liệu rồi tải lên. Hệ thống kiểm tra từng dòng và cho xem trước; chỉ nhập khi toàn bộ file hợp lệ.
        Danh mục và mẫu chưa có sẽ được tạo tự động. Tối đa 2.000 dòng mỗi lần.
      </p>
      <ImportForm />
    </div>
  );
}
