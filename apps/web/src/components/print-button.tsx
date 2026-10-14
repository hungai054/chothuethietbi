'use client';

export function PrintButton() {
  return <button type="button" onClick={() => window.print()} className="rounded bg-slate-900 px-4 py-2 text-white print:hidden">In / Lưu PDF</button>;
}
