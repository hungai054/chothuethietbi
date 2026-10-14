'use client';

import { useEffect, useRef } from 'react';

/** Khung ký tay trên màn hình (chuột/cảm ứng). Ghi ảnh PNG vào ô ẩn `name` mỗi khi nhấc bút. */
export function SignaturePad({ name, label }: { name: string; label: string }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const out = useRef<HTMLInputElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const c = cv.current!;
    const ctx = c.getContext('2d')!;
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
    const pos = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)] as const; };
    const down = (e: PointerEvent) => { drawing.current = true; c.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y); ctx.stroke(); };
    const move = (e: PointerEvent) => { if (!drawing.current) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); };
    const up = () => { if (!drawing.current) return; drawing.current = false; out.current!.value = c.toDataURL('image/png'); };
    c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    return () => { c.removeEventListener('pointerdown', down); c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up); };
  }, []);

  const clear = () => { const c = cv.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); out.current!.value = ''; };
  return (
    <div className="text-sm">
      <div className="mb-1 text-slate-600">{label}</div>
      <canvas ref={cv} width={500} height={180} data-testid={`pad-${name}`} className="w-full max-w-md touch-none rounded border bg-white" />
      <input ref={out} type="hidden" name={name} />
      <button type="button" onClick={clear} className="mt-1 text-xs underline">Xóa, ký lại</button>
    </div>
  );
}
