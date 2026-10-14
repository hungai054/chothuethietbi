import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GROUP_BYS, GROUP_BY_LABEL, isGroupBy, localDateKey } from '@rentpro/core';
import { listBranches, listCategoriesFlat, reportDef, runReport } from '@rentpro/db';
import { ReportView } from '@/components/report-view';
import { Field, Notice, btn, btnGhost, card, input } from '@/components/ui';
import { requireAccess } from '@/lib/session';
import { isUserError, withService } from '@/lib/service';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Q = { from?: string; to?: string; groupBy?: string; branchId?: string; categoryId?: string; error?: string };

async function apply(key: string, f: FormData) {
  'use server';
  const p = new URLSearchParams();
  for (const k of ['from', 'to', 'groupBy', 'branchId', 'categoryId']) {
    const v = String(f.get(k) ?? '').trim();
    if (v) p.set(k, v);
  }
  redirect(`/reports/${key}${p.size ? `?${p}` : ''}`);
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Q> }) {
  const { key } = await params;
  const q = await searchParams;
  const def = reportDef(key);
  if (!def) notFound();
  const sess = await requireAccess(def.feature, def.permission);
  const tz = sess.tenant.timezone;
  const filter = { from: q.from || undefined, to: q.to || undefined, branchId: q.branchId || null, categoryId: q.categoryId || null, groupBy: isGroupBy(q.groupBy) ? q.groupBy : undefined };
  let result = null;
  let error = q.error;
  const lists = await withService(async (c) => ({ branches: await listBranches(c).catch(() => []), categories: await listCategoriesFlat(c).catch(() => []) }));
  try {
    result = await withService((c) => runReport(c, key, filter));
  } catch (e) {
    if (!isUserError(e)) throw e;
    error = e.message;
  }
  const today = localDateKey(new Date(), tz);
  const usesRange = def.range !== 'snapshot';
  const qs = new URLSearchParams(Object.entries(q).filter(([k, v]) => v && k !== 'error') as [string, string][]).toString();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href="/reports" className="text-sm underline">← Báo cáo</Link>
          <h1 className="text-2xl font-semibold" data-testid="report-title">{def.title}</h1>
          {result && <p className="text-sm text-slate-500" data-testid="report-period">Kỳ: {result.period}</p>}
        </div>
        {result && <a href={`/reports/${key}/export${qs ? `?${qs}` : ''}`} className={btn} data-testid="export-xlsx">Xuất Excel</a>}
      </div>
      <Notice error={error} />
      {(usesRange || def.branchFilter) && (
        <form action={apply.bind(null, key)} className={`${card} flex flex-wrap items-end gap-3`} data-testid="report-filter">
          {usesRange && (
            <>
              <Field label="Từ ngày"><input name="from" type="date" defaultValue={q.from ?? (def.range === 'month' ? `${today.slice(0, 8)}01` : '')} className={input} /></Field>
              <Field label="Đến ngày"><input name="to" type="date" defaultValue={q.to ?? today} className={input} /></Field>
            </>
          )}
          {def.groupable && (
            <Field label="Nhóm theo"><select name="groupBy" defaultValue={q.groupBy ?? 'day'} className={input}>{GROUP_BYS.map((g) => <option key={g} value={g}>{GROUP_BY_LABEL[g]}</option>)}</select></Field>
          )}
          {def.branchFilter && lists.branches.length > 0 && (
            <Field label="Chi nhánh"><select name="branchId" defaultValue={q.branchId ?? ''} className={input}><option value="">Tất cả</option>{lists.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          )}
          {def.branchFilter && lists.categories.length > 0 && (
            <Field label="Danh mục"><select name="categoryId" defaultValue={q.categoryId ?? ''} className={input}><option value="">Tất cả</option>{lists.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          )}
          <button className={btnGhost}>Xem báo cáo</button>
        </form>
      )}
      {result && <ReportView r={result} />}
    </div>
  );
}
