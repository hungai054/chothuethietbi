'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { btnGhost, input } from './ui';

export interface ScanResult { tone: 'ok' | 'warn' | 'error'; text: string; href?: string }
type Entry = ScanResult & { code: string; at: number };

const TONE = { ok: 'bg-green-50 text-green-800', warn: 'bg-amber-50 text-amber-900', error: 'bg-red-50 text-red-800' } as const;

/**
 * Máy quét USB hoạt động như bàn phím: gõ mã rồi Enter. Camera dùng @zxing/browser (tải khi bấm nút).
 * `action` là server action: tra mã hoặc ghi nhận kiểm kê.
 */
export function Scanner({ action, placeholder = 'Quét hoặc nhập mã vạch rồi Enter' }: { action: (code: string) => Promise<ScanResult>; placeholder?: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [camera, setCamera] = useState(false);
  const [camError, setCamError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const last = useRef({ code: '', at: 0 });

  const submit = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    const now = Date.now();
    if (last.current.code === code && now - last.current.at < 1500) return; // camera đọc lặp một mã
    last.current = { code, at: now };
    let r: ScanResult;
    try {
      r = await action(code);
    } catch {
      r = { tone: 'error', text: 'Có lỗi khi xử lý mã, vui lòng thử lại.' };
    }
    setEntries((e) => [{ ...r, code, at: now }, ...e].slice(0, 30));
  }, [action]);

  useEffect(() => {
    if (!camera) return;
    let controls: { stop: () => void } | undefined;
    let cancelled = false;
    setCamError('');
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const reader = new BrowserMultiFormatReader();
        const c = await reader.decodeFromVideoDevice(undefined, videoRef.current!, (res) => { if (res) void submit(res.getText()); });
        if (cancelled) c.stop(); else controls = c;
      } catch {
        setCamError('Không mở được camera. Hãy cho phép quyền camera trên trình duyệt (cần HTTPS hoặc localhost).');
        setCamera(false);
      }
    })();
    return () => { cancelled = true; controls?.stop(); };
  }, [camera, submit]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          ref={inputRef} autoFocus aria-label="Mã vạch" placeholder={placeholder} className={`${input} font-mono`} autoComplete="off"
          onKeyDown={async (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const el = e.currentTarget;
            const v = el.value;
            el.value = '';
            await submit(v);
            el.focus();
          }}
        />
        <button type="button" className={btnGhost} onClick={() => setCamera((v) => !v)}>{camera ? 'Tắt camera' : 'Camera'}</button>
      </div>
      {camError && <p role="alert" className="text-sm text-red-700">{camError}</p>}
      {camera && <video ref={videoRef} className="max-h-64 w-full rounded bg-black" muted playsInline />}
      <ul aria-live="polite" className="space-y-1">
        {entries.map((e) => (
          <li key={`${e.at}-${e.code}`} className={`rounded px-3 py-2 text-sm ${TONE[e.tone]}`}>
            <span className="font-mono">{e.code}</span> — {e.href ? <a className="underline" href={e.href}>{e.text}</a> : e.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
