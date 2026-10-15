'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface NavLink { href: string; label: string }
interface Hit { id: string; title: string; subtitle: string | null }
interface Result { models: Hit[]; units: Hit[]; customers: Hit[]; bookings: Hit[] }
interface Item { key: string; group: string; title: string; subtitle?: string | null; href: string }

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();

/** Ctrl/⌘+K: nhảy nhanh tới trang trong menu (đã lọc theo quyền/gói ở layout) và tìm mẫu, thiết bị, khách, đơn qua /api/search. */
export function CommandPalette({ links, labels }: { links: NavLink[]; labels: { model: string; unit: string; customer: string; booking: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const close = useCallback(() => { setOpen(false); setQ(''); setRes(null); setErr(null); opener.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        opener.current = document.activeElement as HTMLElement | null;
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Gõ xong 200ms mới gọi; lượt cũ bị hủy để kết quả không về sai thứ tự
  useEffect(() => {
    const term = q.trim();
    setActive(0);
    if (!open || term.length < 2) { setRes(null); setErr(null); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal, cache: 'no-store' });
        const body = await r.json();
        if (!r.ok) { setErr(body.error ?? 'Không tìm được.'); setRes(null); } else { setErr(null); setRes(body); }
        setBusy(false);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') { setErr('Không kết nối được.'); setBusy(false); }
      }
    }, 200);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [q, open]);

  const items = useMemo<Item[]>(() => {
    const t = norm(q.trim());
    const nav = links.filter((l) => !t || norm(l.label).includes(t)).map((l) => ({ key: `nav:${l.href}`, group: 'Đi tới', title: l.label, href: l.href }));
    const g = (group: string, hits: Hit[] | undefined, href: (h: Hit) => string, k: string): Item[] =>
      (hits ?? []).map((h) => ({ key: `${k}:${h.id}`, group, title: h.title, subtitle: h.subtitle, href: href(h) }));
    return [
      ...g(labels.booking, res?.bookings, (h) => `/bookings/${h.id}`, 'b'),
      ...g(labels.customer, res?.customers, (h) => `/customers/${h.id}`, 'c'),
      ...g(labels.unit, res?.units, (h) => `/inventory/units/${h.id}`, 'u'),
      ...g(labels.model, res?.models, (h) => `/inventory?model=${h.id}`, 'm'),
      ...nav,
    ];
  }, [q, links, labels, res]);

  const go = (it: Item | undefined) => { if (!it) return; close(); router.push(it.href); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[active]); }
  };

  return (
    <>
      <button type="button" onClick={() => { opener.current = document.activeElement as HTMLElement; setOpen(true); }} data-testid="palette-open"
        className="rounded border border-current/30 px-2 py-1 text-xs opacity-80 hover:opacity-100" aria-label="Tìm nhanh (Ctrl+K)">
        Tìm nhanh <kbd className="ml-1 opacity-70">Ctrl K</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh] text-slate-900" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div role="dialog" aria-modal="true" aria-label="Tìm nhanh" className="w-full max-w-xl overflow-hidden rounded-lg bg-white shadow-xl" data-testid="palette" onKeyDown={onKeyDown}>
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm đơn, khách, thiết bị hoặc gõ tên trang…" aria-label="Từ khóa"
              role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={items[active] ? `pal-${active}` : undefined}
              maxLength={80} className="w-full border-b px-4 py-3 outline-none" />
            <ul id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto py-1" data-testid="palette-list">
              {items.map((it, i) => (
                <li key={it.key} id={`pal-${i}`} role="option" aria-selected={i === active} data-testid="palette-item"
                  onMouseEnter={() => setActive(i)} onClick={() => go(it)}
                  className={`flex cursor-pointer items-baseline justify-between gap-3 px-4 py-2 text-sm ${i === active ? 'bg-slate-100' : ''}`}>
                  <span><span className="font-medium">{it.title}</span>{it.subtitle && <span className="ml-2 text-slate-500">{it.subtitle}</span>}</span>
                  <span className="shrink-0 text-xs text-slate-400">{it.group}</span>
                </li>
              ))}
            </ul>
            <p className="border-t px-4 py-2 text-xs text-slate-500" role="status" data-testid="palette-status">
              {err ?? (busy ? 'Đang tìm…' : q.trim().length >= 2 && items.length === 0 ? 'Không có kết quả.' : 'Gõ ít nhất 2 ký tự để tìm. ↑↓ chọn · Enter mở · Esc đóng')}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
