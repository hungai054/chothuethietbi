'use client';

import { useEffect, useState, useTransition } from 'react';

/** Hiện số giấy tờ đầy đủ trong 15 giây rồi tự ẩn. Mỗi lần bấm đều được ghi nhật ký ở máy chủ. */
export function RevealNumber({ action, last4 }: { action: () => Promise<{ ok: true; number: string } | { ok: false; error: string }>; last4: string }) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => setValue(null), 15_000);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono" data-testid="id-number">{value ?? `••••${last4}`}</span>
      <button type="button" className="text-xs underline" disabled={pending}
        onClick={() => start(async () => { const r = await action(); if (r.ok) { setValue(r.number); setError(''); } else setError(r.error); })}>
        {value ? 'Ẩn' : 'Xem số đầy đủ'}
      </button>
      {error && <span role="alert" className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
