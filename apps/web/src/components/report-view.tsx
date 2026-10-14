import Link from 'next/link';
import type { ChartSpec, ColumnType, ReportCard, ReportResult, ReportRow, ReportSection } from '@rentpro/core';
import { Empty, card } from './ui';

const nf = new Intl.NumberFormat('vi-VN');

export function formatCell(v: string | number | null | undefined, t: ColumnType): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v;
  switch (t) {
    case 'money': return `${nf.format(v)} đ`;
    case 'percent': return `${(v * 100).toFixed(1).replace('.', ',')}%`;
    case 'hours': return `${nf.format(Math.round(v * 10) / 10)} giờ`;
    default: return nf.format(v);
  }
}

function Chart({ spec, rows, label }: { spec: ChartSpec; rows: ReportRow[]; label: string }) {
  const s = spec.series[0]!;
  const data = rows.map((r) => ({ l: String(r[spec.labelKey] ?? ''), v: Number(r[s.key] ?? 0) }));
  if (data.length === 0 || data.every((d) => d.v === 0)) return null;
  const W = 640, H = 220, PAD = { l: 8, r: 8, t: 12, b: 36 };
  const max = Math.max(...data.map((d) => d.v), 1);
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const step = iw / data.length;
  const x = (i: number) => PAD.l + step * i + step / 2;
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const every = Math.ceil(data.length / 12);
  return (
    <figure className="mb-3" data-testid="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Biểu đồ ${label}`} className="w-full max-w-3xl">
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih} y2={PAD.t + ih} stroke="#cbd5e1" />
        {spec.type === 'bar'
          ? data.map((d, i) => <rect key={i} x={x(i) - Math.max(1, step * 0.35)} width={Math.max(2, step * 0.7)} y={y(d.v)} height={PAD.t + ih - y(d.v)} fill="#0f172a"><title>{`${d.l}: ${nf.format(d.v)}`}</title></rect>)
          : <polyline fill="none" stroke="#0f172a" strokeWidth={2} points={data.map((d, i) => `${x(i)},${y(d.v)}`).join(' ')} />}
        {data.map((d, i) => (i % every === 0 ? <text key={i} x={x(i)} y={H - 16} fontSize={10} textAnchor="middle" fill="#475569">{d.l.length > 12 ? `${d.l.slice(0, 11)}…` : d.l}</text> : null))}
        <text x={W - PAD.r} y={10} fontSize={10} textAnchor="end" fill="#475569">{`Cao nhất: ${nf.format(max)}`}</text>
      </svg>
      <figcaption className="text-xs text-slate-500">{s.label}</figcaption>
    </figure>
  );
}

function Cards({ cards }: { cards: ReportCard[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="report-cards">
      {cards.map((c) => {
        const inner = (
          <>
            <div className={`text-xl font-semibold ${c.tone === 'warn' ? 'text-red-700' : c.tone === 'good' ? 'text-green-700' : ''}`}>{formatCell(c.value, c.type)}</div>
            <div className="text-xs text-slate-500">{c.label}</div>
            {c.hint && <div className="text-xs text-slate-400">{c.hint}</div>}
          </>
        );
        return c.href ? <Link key={c.label} href={c.href} className={`${card} block hover:bg-slate-50`}>{inner}</Link> : <div key={c.label} className={card}>{inner}</div>;
      })}
    </div>
  );
}

function Section({ s }: { s: ReportSection }) {
  return (
    <section className={`${card} space-y-2`} data-testid="report-section">
      <h2 className="font-medium">{s.title}</h2>
      {s.note && <p className="text-xs text-slate-500">{s.note}</p>}
      {s.chart && <Chart spec={s.chart} rows={s.rows} label={s.title} />}
      {s.rows.length === 0 ? <Empty>Không có dữ liệu.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left">{s.columns.map((c) => <th key={c.key} className={`py-2 pr-3 ${c.type === 'text' || c.type === 'date' ? '' : 'text-right'}`}>{c.label}</th>)}</tr></thead>
            <tbody>
              {s.rows.map((r, i) => (
                <tr key={i} className="border-b">{s.columns.map((c) => <td key={c.key} className={`py-1.5 pr-3 ${c.type === 'text' || c.type === 'date' ? '' : 'text-right tabular-nums'}`}>{formatCell(r[c.key], c.type)}</td>)}</tr>
              ))}
            </tbody>
            {s.totals && <tfoot><tr className="border-t-2 font-semibold">{s.columns.map((c) => <td key={c.key} className={`py-1.5 pr-3 ${c.type === 'text' || c.type === 'date' ? '' : 'text-right tabular-nums'}`}>{formatCell(s.totals![c.key], c.type)}</td>)}</tr></tfoot>}
          </table>
        </div>
      )}
    </section>
  );
}

/** Hiển thị mọi báo cáo từ cùng một cấu trúc: thẻ tóm tắt, bảng (có dòng tổng), biểu đồ, ghi chú. */
export function ReportView({ r }: { r: ReportResult }) {
  return (
    <div className="space-y-4">
      {r.cards && r.cards.length > 0 && <Cards cards={r.cards} />}
      {r.sections.map((s, i) => <Section key={i} s={s} />)}
      {r.notes && r.notes.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </div>
  );
}
