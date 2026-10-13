import type { ReactNode } from 'react';

export const input = 'w-full rounded border bg-white px-3 py-2';
export const btn = 'rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60';
export const btnGhost = 'rounded border bg-white px-4 py-2';
export const card = 'rounded-lg bg-white p-5 shadow-sm';

export function Notice({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <p role="alert" className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (ok) return <p role="status" className="mb-4 rounded bg-green-50 p-3 text-sm text-green-700">{ok}</p>;
  return null;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block text-slate-600">{label}</span>{children}</label>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-white p-8 text-center text-slate-500">{children}</p>;
}
