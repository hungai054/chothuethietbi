import './extensions.generated'; // đăng ký extension lúc build (file sinh bởi pnpm ext:sync)
import { dispatchPlatformEmails, pruneJobRuns, runAllJobs, sweepSubscriptions, type JobDeps } from '@rentpro/db';
import { depsFromEnv, platformEmailFrom } from './config';

/** Một vòng cho mọi tenant; mỗi tenant/bước tự cô lập lỗi nên vòng lặp không bao giờ chết vì một cửa hàng. */
export async function tick(deps: JobDeps, log: (m: string) => void = console.log): Promise<void> {
  const started = Date.now();
  const res = await runAllJobs(deps);
  const sum = res.reduce((a, r) => ({
    holds: a.holds + r.holdsReleased, queued: a.queued + (r.scan?.queued ?? 0), sent: a.sent + (r.dispatch?.sent ?? 0), failed: a.failed + (r.dispatch?.failed ?? 0), errors: a.errors + r.errors.length,
  }), { holds: 0, queued: 0, sent: 0, failed: 0, errors: 0 });
  log(`[worker] ${res.length} tenant · hủy giữ chỗ ${sum.holds} · tạo tin ${sum.queued} · đã gửi ${sum.sent} · thất bại ${sum.failed} · lỗi tác vụ ${sum.errors} · ${Date.now() - started} ms`);
  for (const r of res) for (const e of r.errors) log(`[worker] tenant ${r.tenantId}: ${e}`);
  await billingStep(deps, log);
}

/** Thuê bao: chuyển chỉ đọc/khóa tenant hết hạn, xếp thư nhắc, rồi gửi thư của nền tảng. Lỗi không làm hỏng vòng chạy. */
async function billingStep(deps: JobDeps, log: (m: string) => void): Promise<void> {
  try {
    const s = await sweepSubscriptions(deps.adminPool);
    const m = await dispatchPlatformEmails(deps.adminPool, platformEmailFrom(process.env));
    if (s.readOnly.length + s.suspended.length + s.reopened.length + s.reminders + m.sent + m.failed > 0) {
      log(`[worker] thuê bao: chỉ đọc ${s.readOnly.length} · khóa ${s.suspended.length} · mở lại ${s.reopened.length} · nhắc ${s.reminders} · thư gửi ${m.sent}, lỗi ${m.failed}`);
    }
  } catch (e) {
    log(`[worker] bước thuê bao lỗi: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  const once = process.argv.includes('--once');
  const every = Math.max(10, Number(process.env.WORKER_INTERVAL_SECONDS ?? 60)) * 1000;
  const deps = depsFromEnv();
  let stopping = false;
  let lastPrune = 0;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`[worker] khởi động, chu kỳ ${every / 1000}s${once ? ' (chạy một lần)' : ''}`);
  do {
    try {
      await tick(deps);
      if (Date.now() - lastPrune > 86_400_000) { lastPrune = Date.now(); await pruneJobRuns(deps.adminPool); }
    } catch (e) {
      console.error('[worker] vòng chạy lỗi:', e instanceof Error ? e.message : e);
    }
    if (once) break;
    for (let waited = 0; waited < every && !stopping; waited += 500) await new Promise((r) => setTimeout(r, 500));
  } while (!stopping);
  await deps.close();
  console.log('[worker] đã dừng');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('main.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
