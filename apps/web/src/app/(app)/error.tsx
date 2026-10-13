'use client';

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-lg bg-white p-6 text-center shadow-sm">
      <h1 className="text-lg font-semibold">Có lỗi xảy ra</h1>
      <p className="mt-2 text-sm text-slate-600">Thao tác chưa hoàn tất. Bạn có thể không có quyền với mục này, hoặc hệ thống đang gặp sự cố tạm thời.</p>
      <div className="mt-4 flex justify-center gap-3 text-sm">
        <button className="rounded bg-slate-900 px-4 py-2 text-white" onClick={reset}>Thử lại</button>
        <a className="rounded border px-4 py-2" href="/">Về trang chủ</a>
      </div>
    </div>
  );
}
