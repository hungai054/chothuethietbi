'use client';
import { useState } from 'react';
import { btnGhost, input } from '@/components/ui';
import { MAX_BOOKING_LINES } from '@/lib/booking-limits';

const MIN_ROWS = 4;

/** Các dòng thiết bị của form tạo đơn: mặc định 4 dòng, bấm "Thêm dòng" để thêm (tối đa MAX_BOOKING_LINES) mà không tải lại trang. */
export function BookingLines({ models, defaults }: { models: { id: string; name: string; tracked: boolean }[]; defaults: Record<string, string | undefined> }) {
  const filled = Math.max(0, ...Array.from({ length: MAX_BOOKING_LINES }, (_, i) => (defaults[`m${i + 1}`] ? i + 1 : 0)));
  const [rows, setRows] = useState(Math.max(MIN_ROWS, filled));
  return (
    <>
      {Array.from({ length: rows }, (_, i) => i + 1).map((i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem] gap-2">
          <select name={`m${i}`} aria-label={`Thiết bị ${i}`} defaultValue={defaults[`m${i}`] ?? ''} className={input}>
            <option value="">{i === 1 ? '— chọn thiết bị —' : '— thêm thiết bị (tùy chọn) —'}</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.tracked ? '' : ' (theo số lượng)'}</option>)}
          </select>
          <input name={`q${i}`} aria-label={`Số lượng ${i}`} type="number" min={1} defaultValue={defaults[`q${i}`] ?? '1'} className={input} />
        </div>
      ))}
      <div className="flex items-center gap-3">
        <button type="button" className={btnGhost} data-testid="add-line" disabled={rows >= MAX_BOOKING_LINES} onClick={() => setRows((r) => Math.min(r + 1, MAX_BOOKING_LINES))}>+ Thêm dòng thiết bị</button>
        <span className="text-xs text-slate-500">{rows}/{MAX_BOOKING_LINES} dòng</span>
      </div>
    </>
  );
}
