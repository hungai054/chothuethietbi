'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

interface Bar { allocationId: string; bookingId: string | null; code: string | null; customer: string | null; status: string; start: string; end: string; rentalEnd: string | null }
interface Row { unitId: string; barcode: string; modelId: string; modelName: string; unitStatus: string; bars: Bar[] }
type Result = { ok: true; message?: string; url?: string } | { ok: false; error: string };
interface Props {
  rows: Row[]; fromIso: string; toIso: string; tz: string; canEdit: boolean;
  customers: { id: string; name: string; phone: string }[];
  move: (bookingId: string, newStartIso: string) => Promise<Result>;
  swap: (allocationId: string, unitId: string) => Promise<Result>;
  create: (i: { unitId: string; modelId: string; customerId: string; startIso: string; endIso: string }) => Promise<Result>;
}

const H = 3_600_000;
const ROW_H = 38;
const LABEL_W = 200;
const GRID_W = 1200;
const TONE: Record<string, string> = {
  HOLD: 'bg-amber-400 text-amber-950', CONFIRMED: 'bg-blue-500 text-white', ACTIVE: 'bg-green-600 text-white', MAINTENANCE: 'bg-slate-400 text-white',
};
const LABEL: Record<string, string> = { HOLD: 'Giữ chỗ', CONFIRMED: 'Đã xác nhận', ACTIVE: 'Đang thuê', MAINTENANCE: 'Bảo trì' };

/** Lịch Gantt: hàng = thiết bị, cột = thời gian. Mọi thay đổi gọi server action; trùng lịch bị chặn ở server và ràng buộc DB. */
export function TimelineGrid({ rows, fromIso, toIso, tz, canEdit, customers, move, swap, create }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  const hours = (to - from) / H;
  const pph = GRID_W / hours;
  const snap = [1, 2, 3, 6, 12, 24].find((s) => s * pph >= 6) ?? 24;
  const days = Math.round(hours / 24);

  const [drag, setDrag] = useState<{ id: string; row: number; x0: number; y0: number; dx: number; dy: number } | null>(null);
  const [sel, setSel] = useState<{ row: number; x0: number; x1: number; left: number } | null>(null);
  const [panel, setPanel] = useState<{ row: number; startMs: number; endMs: number } | null>(null);
  const [customer, setCustomer] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const moved = useRef(false);

  const fmt = (ms: number, withTime = true) =>
    new Intl.DateTimeFormat('vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(ms));
  const weekday = (ms: number) => new Intl.DateTimeFormat('vi-VN', { timeZone: tz, weekday: 'short' }).format(new Date(ms));

  const run = (p: Promise<Result>) =>
    start(async () => {
      const r = await p;
      setMsg(r.ok ? { ok: true, text: r.message ?? 'Đã lưu.' } : { ok: false, text: r.error });
      if (r.ok && r.url) router.push(r.url);
      else router.refresh();
    });

  const roundH = (px: number) => Math.round(px / pph / snap) * snap;

  function onBarDown(e: React.PointerEvent, bar: Bar, row: number) {
    if (!canEdit || !bar.bookingId || bar.status === 'MAINTENANCE') return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    moved.current = false;
    setDrag({ id: bar.allocationId, row, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 });
  }
  function onBarMove(e: React.PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved.current = true;
    setDrag({ ...drag, dx, dy });
  }
  function onBarUp(bar: Bar) {
    const d = drag;
    setDrag(null);
    if (!d || !bar.bookingId) return;
    if (!moved.current) { router.push(`/bookings/${bar.bookingId}`); return; }
    const rowDelta = Math.round(d.dy / ROW_H);
    if (rowDelta !== 0) {
      const target = rows[d.row + rowDelta];
      if (!target) return setMsg({ ok: false, text: 'Thả ở ngoài danh sách thiết bị.' });
      if (target.modelId !== rows[d.row]!.modelId) return setMsg({ ok: false, text: 'Chỉ đổi được sang thiết bị cùng mẫu.' });
      return run(swap(bar.allocationId, target.unitId));
    }
    const h = roundH(d.dx);
    if (h === 0) return;
    run(move(bar.bookingId, new Date(new Date(bar.start).getTime() + h * H).toISOString()));
  }

  function onLaneDown(e: React.PointerEvent<HTMLDivElement>, row: number) {
    if (!canEdit || e.target !== e.currentTarget) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const left = e.currentTarget.getBoundingClientRect().left;
    setSel({ row, x0: e.clientX - left, x1: e.clientX - left, left });
  }
  function onLaneUp() {
    const s = sel;
    setSel(null);
    if (!s || Math.abs(s.x1 - s.x0) < 6) return;
    const a = Math.floor(Math.min(s.x0, s.x1) / pph / snap) * snap;
    const b = Math.max(Math.ceil(Math.max(s.x0, s.x1) / pph / snap) * snap, a + snap);
    setPanel({ row: s.row, startMs: from + a * H, endMs: from + b * H });
    setMsg(null);
  }

  const nowX = ((Date.now() - from) / H) * pph;

  return (
    <div className="space-y-2">
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`rounded p-3 text-sm ${msg.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`}>{msg.text}</p>}
      <div className="overflow-x-auto rounded-lg bg-white shadow-sm" aria-busy={pending}>
        <div style={{ width: LABEL_W + GRID_W }} className="relative select-none">
          <div className="sticky top-0 z-20 flex border-b bg-slate-50 text-xs text-slate-600">
            <div style={{ width: LABEL_W }} className="sticky left-0 z-30 shrink-0 border-r bg-slate-50 p-2 font-medium">Thiết bị</div>
            <div className="relative" style={{ width: GRID_W, height: 34 }}>
              {Array.from({ length: days }, (_, i) => (
                <div key={i} className="absolute top-0 h-full border-l px-1" style={{ left: i * 24 * pph, width: 24 * pph }}>
                  {days <= 14 ? `${weekday(from + i * 24 * H)} ${fmt(from + i * 24 * H, false)}` : fmt(from + i * 24 * H, false)}
                </div>
              ))}
            </div>
          </div>
          {rows.length === 0 && <p className="p-6 text-center text-slate-500">Chưa có thiết bị để hiển thị.</p>}
          {rows.map((r, i) => (
            <div key={r.unitId} className="flex border-b" style={{ height: ROW_H }} data-testid={`row-${r.barcode}`}>
              <div style={{ width: LABEL_W }} className="sticky left-0 z-10 shrink-0 truncate border-r bg-white px-2 py-1 text-xs" title={`${r.modelName} · ${r.barcode}`}>
                <span className="font-mono font-medium">{r.barcode}</span> <span className="text-slate-500">{r.modelName}</span>
              </div>
              <div
                className="relative cursor-crosshair" style={{ width: GRID_W, height: ROW_H, backgroundImage: 'linear-gradient(to right, #e2e8f0 1px, transparent 1px)', backgroundSize: `${24 * pph}px 100%` }}
                data-testid={`lane-${r.barcode}`}
                onPointerDown={(e) => onLaneDown(e, i)}
                onPointerMove={(e) => sel && sel.row === i && setSel({ ...sel, x1: e.clientX - sel.left })}
                onPointerUp={onLaneUp}
              >
                {nowX > 0 && nowX < GRID_W && <div className="pointer-events-none absolute top-0 h-full w-px bg-red-500" style={{ left: nowX }} />}
                {r.bars.map((b) => {
                  const left = ((new Date(b.start).getTime() - from) / H) * pph;
                  const w = ((new Date(b.end).getTime() - new Date(b.start).getTime()) / H) * pph;
                  const rentalW = b.rentalEnd ? Math.min(w, ((new Date(b.rentalEnd).getTime() - new Date(b.start).getTime()) / H) * pph) : w;
                  const dragging = drag?.id === b.allocationId;
                  return (
                    <div
                      key={b.allocationId} data-testid={`bar-${b.code ?? 'maintenance'}`} role="link" tabIndex={0}
                      aria-label={`${b.code ?? 'Bảo trì'} ${LABEL[b.status] ?? b.status} ${b.customer ?? ''}`}
                      title={`${b.code ?? 'Bảo trì'} · ${b.customer ?? ''}\n${LABEL[b.status] ?? b.status}\n${fmt(new Date(b.start).getTime())} → ${fmt(new Date(b.rentalEnd ?? b.end).getTime())}`}
                      className={`absolute top-1 overflow-hidden rounded text-xs ${TONE[b.status] ?? 'bg-slate-500 text-white'} ${canEdit && b.bookingId && b.status !== 'MAINTENANCE' ? 'cursor-grab' : ''} ${dragging ? 'z-30 opacity-80 shadow-lg' : ''}`}
                      style={{ left, width: Math.max(w, 6), height: ROW_H - 8, transform: dragging ? `translate(${drag!.dx}px, ${drag!.dy}px)` : undefined, touchAction: 'none' }}
                      onPointerDown={(e) => onBarDown(e, b, i)} onPointerMove={onBarMove} onPointerUp={() => onBarUp(b)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && b.bookingId) router.push(`/bookings/${b.bookingId}`); }}
                    >
                      <div className="truncate px-1 py-0.5" style={{ width: rentalW }}>{b.code ?? 'Bảo trì'}{b.customer ? ` · ${b.customer}` : ''}</div>
                      {w > rentalW + 1 && <div className="absolute top-0 h-full opacity-60" style={{ left: rentalW, width: w - rentalW, backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 3px, transparent 3px 6px)' }} />}
                    </div>
                  );
                })}
                {sel && sel.row === i && <div className="pointer-events-none absolute top-1 rounded bg-blue-300/60 ring-1 ring-blue-500" style={{ left: Math.min(sel.x0, sel.x1), width: Math.abs(sel.x1 - sel.x0), height: ROW_H - 8 }} />}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-slate-600" aria-label="Chú thích">
        {Object.entries(LABEL).map(([k, v]) => <span key={k} className="flex items-center gap-1"><span className={`inline-block h-3 w-3 rounded ${TONE[k]!.split(' ')[0]}`} />{v}</span>)}
        <span>Vùng sọc = thời gian đệm sau khi trả. Vạch đỏ = bây giờ. Bước kéo: {snap} giờ.</span>
      </div>

      {panel && (
        <div className="rounded-lg border bg-white p-4 shadow-sm" role="dialog" aria-label="Giữ chỗ nhanh">
          <h2 className="font-medium">Giữ chỗ nhanh: <span className="font-mono">{rows[panel.row]!.barcode}</span> · {rows[panel.row]!.modelName}</h2>
          <p className="text-sm text-slate-600">{fmt(panel.startMs)} → {fmt(panel.endMs)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="Khách hàng" className="rounded border px-3 py-2 text-sm">
              <option value="">— chọn khách hàng —</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.phone}</option>)}
            </select>
            <button disabled={pending} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-60"
              onClick={() => { const r = rows[panel.row]!; run(create({ unitId: r.unitId, modelId: r.modelId, customerId: customer, startIso: new Date(panel.startMs).toISOString(), endIso: new Date(panel.endMs).toISOString() })); setPanel(null); }}>
              Giữ chỗ
            </button>
            <button className="rounded border px-4 py-2 text-sm" onClick={() => setPanel(null)}>Bỏ</button>
          </div>
        </div>
      )}
    </div>
  );
}
