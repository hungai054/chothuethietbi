import type { DepositHook, PricingHook, Permission, ReportFilter, ReportResult } from '@rentpro/core';
import { applyDepositHook, localDateKey, zonedTimeToUtc } from '@rentpro/core';
import {
  ExtensionVeto, HOOK_TIMEOUT_MS, checkCompatibility, getExtension, parseExtensionConfig, withTimeout,
  type BookingDraft, type BookingInfo, type ContractInfo, type ExtensionContext, type ExtensionDefinition, type ExtensionJob, type ExtensionPage, type ExtensionReport, type HookName,
  type OutgoingNotice, type ReturnInfo,
} from '@rentpro/extension-sdk';
import type { ResolvedFeatures } from '@rentpro/tenancy';
import type { Db } from './client';
import { ValidationError, type ServiceCtx } from './service';

type Row = Record<string, any>;

export interface ActiveExtension { def: ExtensionDefinition; config: Record<string, unknown> }

/**
 * Extension đang hiệu lực của một cửa hàng: được bật trong `tenant_extension`, gói có tính năng `extensions`,
 * đã đăng ký ở build, tương thích SDK và cấu hình hợp lệ. Cái nào không đạt thì bỏ qua (không bao giờ làm hỏng luồng lõi).
 */
export async function loadActiveExtensions(db: Db, features: ResolvedFeatures): Promise<{ active: ActiveExtension[]; skipped: { code: string; reason: string }[] }> {
  if (features['extensions'] !== true) return { active: [], skipped: [] };
  const rows = (await db.query('SELECT extension_code, config FROM tenant_extension WHERE enabled ORDER BY extension_code')).rows;
  const active: ActiveExtension[] = [];
  const skipped: { code: string; reason: string }[] = [];
  for (const r of rows) {
    const def = getExtension(r.extension_code);
    if (!def) { skipped.push({ code: r.extension_code, reason: 'Extension chưa được cài trong bản triển khai này.' }); continue; }
    const compat = checkCompatibility(def.manifest);
    if (compat) { skipped.push({ code: r.extension_code, reason: compat }); continue; }
    const cfg = parseExtensionConfig(def, r.config);
    if (!cfg.ok) { skipped.push({ code: r.extension_code, reason: `Cấu hình không hợp lệ: ${cfg.error}` }); continue; }
    active.push({ def, config: cfg.config });
  }
  return { active, skipped };
}

const FORBIDDEN_READ = /\b(insert|update|delete|alter|drop|create|truncate|grant|revoke|copy|call|do|set|reset|vacuum|listen|notify|lock|pg_sleep|nextval|setval|set_config|lo_\w+|dblink\w*)\b/i;
const MAX_READ_ROWS = 5000;

/** Chỉ một câu SELECT (hoặc WITH … SELECT), không chứa lệnh ghi/đổi cấu trúc. RLS của cửa hàng vẫn áp dụng. */
export function validateReadSql(sql: string): string | null {
  const s = sql.trim().replace(/;+\s*$/, '');
  if (!/^(select|with)\b/i.test(s)) return 'Truy vấn của extension chỉ được bắt đầu bằng SELECT (hoặc WITH … SELECT).';
  if (s.includes(';')) return 'Chỉ được một câu lệnh mỗi lần truy vấn.';
  if (/--|\/\*/.test(s)) return 'Không dùng chú thích trong truy vấn.';
  if (FORBIDDEN_READ.test(s)) return 'Truy vấn của extension chỉ được đọc dữ liệu.';
  return null;
}

export interface ExtensionErrorEntry { code: string; hook: string; message: string }

/**
 * Cầu nối giữa lõi và các extension của MỘT cửa hàng trong MỘT giao dịch. Mọi lời gọi vào extension đi qua đây:
 * có timeout, bắt lỗi, ghi nhật ký; chỉ móc BẮT BUỘC hoặc việc từ chối có chủ đích (ExtensionVeto) mới chặn được thao tác.
 */
export class ExtensionHost {
  readonly errors: ExtensionErrorEntry[] = [];
  constructor(private readonly db: Db, readonly tenantId: string, private readonly timezone: string, readonly active: ActiveExtension[], readonly skipped: { code: string; reason: string }[] = []) {}

  private ctxOf(a: ActiveExtension): ExtensionContext {
    const code = a.def.manifest.code;
    const db = this.db;
    const tenantId = this.tenantId;
    return {
      tenantId, timezone: this.timezone, config: a.config,
      log: (message, data) => { this.errors.push({ code, hook: 'log', message: `${message}${data === undefined ? '' : ` ${JSON.stringify(data).slice(0, 500)}`}` }); },
      store: {
        get: async (key) => (await db.query('SELECT value FROM extension_data WHERE extension_code=$1 AND key=$2', [code, key])).rows[0]?.value ?? null,
        set: async (key, value) => { await db.query(
          `INSERT INTO extension_data(tenant_id,extension_code,key,value) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, extension_code, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
          [tenantId, code, key, JSON.stringify(value)]); },
        delete: async (key) => { await db.query('DELETE FROM extension_data WHERE extension_code=$1 AND key=$2', [code, key]); },
        list: async (prefix = '') => (await db.query(`SELECT key, value FROM extension_data WHERE extension_code=$1 AND left(key, length($2)) = $2 ORDER BY key LIMIT 1000`, [code, prefix])).rows as { key: string; value: unknown }[],
      },
      read: {
        query: async <T,>(sql: string, params: unknown[] = []) => {
          const bad = validateReadSql(sql);
          if (bad) throw new Error(bad);
          await db.query('SAVEPOINT ext_read');
          try {
            await db.query('SET LOCAL statement_timeout = 3000');
            const r = await db.query(`SELECT * FROM (${sql.trim().replace(/;+\s*$/, '')}) AS q LIMIT ${MAX_READ_ROWS}`, params);
            await db.query('SET LOCAL statement_timeout TO DEFAULT');
            await db.query('RELEASE SAVEPOINT ext_read');
            return r.rows as T[];
          } catch (e) {
            await db.query('ROLLBACK TO SAVEPOINT ext_read');
            await db.query('RELEASE SAVEPOINT ext_read');
            throw e;
          }
        },
      },
    };
  }

  private fail(code: string, hook: string, e: unknown) {
    this.errors.push({ code, hook, message: e instanceof Error ? e.message : String(e) });
  }

  private with(hook: HookName) { return this.active.filter((a) => a.def.hooks?.[hook]); }
  private isRequired(a: ActiveExtension, hook: HookName) { return a.def.manifest.required?.includes(hook) ?? false; }

  /** Gọi một móc bất đồng bộ. Trả về kết quả, hoặc undefined nếu móc lỗi/quá thời gian và không bắt buộc. */
  private async call<T>(a: ActiveExtension, hook: HookName, fn: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      return { ok: true, value: await withTimeout(fn, HOOK_TIMEOUT_MS) };
    } catch (e) {
      if (e instanceof ExtensionVeto) throw new ValidationError(`${a.def.manifest.name}: ${e.message}`);
      this.fail(a.def.manifest.code, hook, e);
      if (this.isRequired(a, hook)) throw new ValidationError(`Không thực hiện được vì extension "${a.def.manifest.name}" gặp lỗi (${e instanceof Error ? e.message : 'không rõ'}). Hãy liên hệ quản trị.`);
      return { ok: false };
    }
  }

  // ----- Móc đồng bộ: gộp vào hook sẵn có của lõi -----
  pricingHook(): PricingHook | undefined {
    const list = this.with('pricing.adjust');
    if (list.length === 0) return undefined;
    return (quote) => {
      const out: ReturnType<PricingHook> = [];
      for (const a of list) {
        try { out.push(...a.def.hooks!['pricing.adjust']!(this.ctxOf(a), quote)); } catch (e) { this.fail(a.def.manifest.code, 'pricing.adjust', e); }
      }
      return out;
    };
  }

  depositHook(): DepositHook | undefined {
    const list = this.with('deposit.suggest');
    if (list.length === 0) return undefined;
    return (c) => {
      let amount = c.suggested;
      for (const a of list) {
        const r = applyDepositHook(amount, c, (x) => a.def.hooks!['deposit.suggest']!(this.ctxOf(a), x));
        if (r.warning) this.fail(a.def.manifest.code, 'deposit.suggest', new Error(r.warning));
        amount = r.amount;
      }
      return amount;
    };
  }

  // ----- Móc bất đồng bộ -----
  async beforeBookingCreate(b: BookingDraft): Promise<void> {
    for (const a of this.with('booking.beforeCreate')) await this.call(a, 'booking.beforeCreate', () => a.def.hooks!['booking.beforeCreate']!(this.ctxOf(a), b));
  }
  async afterBookingConfirm(b: BookingInfo): Promise<void> {
    for (const a of this.with('booking.afterConfirm')) await this.call(a, 'booking.afterConfirm', () => a.def.hooks!['booking.afterConfirm']!(this.ctxOf(a), b));
  }
  async afterBookingReturn(b: ReturnInfo): Promise<void> {
    for (const a of this.with('booking.afterReturn')) await this.call(a, 'booking.afterReturn', () => a.def.hooks!['booking.afterReturn']!(this.ctxOf(a), b));
  }

  /** Trả tin sau khi các extension xử lý; null = bị chặn. Kết quả sai định dạng bị bỏ qua (giữ tin gốc). */
  async beforeNotificationSend(m: OutgoingNotice): Promise<OutgoingNotice | null> {
    let cur = m;
    for (const a of this.with('notification.beforeSend')) {
      const r = await this.call(a, 'notification.beforeSend', () => a.def.hooks!['notification.beforeSend']!(this.ctxOf(a), { ...cur }));
      if (!r.ok) continue;
      if (r.value === null) return null;
      if (r.value && typeof r.value.body === 'string' && r.value.body.trim() !== '' && r.value.body.length <= 2000 && r.value.to === cur.to && r.value.channel === cur.channel) cur = { ...cur, body: r.value.body, subject: r.value.subject ?? cur.subject };
      else this.fail(a.def.manifest.code, 'notification.beforeSend', new Error('Kết quả không hợp lệ (không được đổi người nhận/kênh, nội dung không rỗng và ≤ 2000 ký tự); giữ tin gốc.'));
    }
    return cur;
  }

  /** Biến bổ sung cho mẫu hợp đồng: `{ext.<tên>}`. */
  async contractVariables(c: ContractInfo): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const a of this.with('contract.extraVariables')) {
      const r = await this.call(a, 'contract.extraVariables', () => a.def.hooks!['contract.extraVariables']!(this.ctxOf(a), c));
      if (!r.ok || !r.value || typeof r.value !== 'object') continue;
      for (const [k, v] of Object.entries(r.value)) {
        if (/^[a-z0-9_]+$/.test(k) && typeof v === 'string' && v.length <= 500) out[`ext.${k}`] = v;
        else this.fail(a.def.manifest.code, 'contract.extraVariables', new Error(`Biến "${k}" bị bỏ qua (tên chỉ gồm a-z, 0-9, _; giá trị là chuỗi ≤ 500 ký tự).`));
      }
    }
    return out;
  }

  // ----- Báo cáo, trang, tác vụ -----
  reports(): { code: string; name: string; report: ExtensionReport }[] {
    return this.active.flatMap((a) => (a.def.reports ?? []).map((report) => ({ code: a.def.manifest.code, name: a.def.manifest.name, report })));
  }
  pages(): { code: string; page: ExtensionPage }[] {
    return this.active.flatMap((a) => (a.def.pages ?? []).map((page) => ({ code: a.def.manifest.code, page })));
  }
  jobs(): { code: string; job: ExtensionJob; active: ActiveExtension }[] {
    return this.active.flatMap((a) => (a.def.jobs ?? []).map((job) => ({ code: a.def.manifest.code, job, active: a })));
  }

  async runReport(code: string, key: string, filter: ReportFilter): Promise<ReportResult> {
    const a = this.active.find((x) => x.def.manifest.code === code);
    const r = a?.def.reports?.find((x) => x.key === key);
    if (!a || !r) throw new ValidationError('Báo cáo không tồn tại.');
    try {
      return await withTimeout(() => r.run(this.ctxOf(a), filter), 15_000);
    } catch (e) {
      if (e instanceof ExtensionVeto) throw new ValidationError(e.message);
      this.fail(code, `report:${key}`, e);
      throw new ValidationError(`Báo cáo của extension "${a.def.manifest.name}" gặp lỗi và không hiển thị được. Quản trị viên có thể xem chi tiết trong nhật ký lỗi extension.`);
    }
  }

  async renderPage(code: string, path: string): Promise<{ title: string; permission: Permission; result: ReportResult }> {
    const a = this.active.find((x) => x.def.manifest.code === code);
    const p = a?.def.pages?.find((x) => x.path === path);
    if (!a || !p) throw new ValidationError('Trang không tồn tại.');
    try {
      return { title: p.title, permission: p.permission ?? 'reports.view', result: await withTimeout(() => p.render(this.ctxOf(a)), 15_000) };
    } catch (e) {
      this.fail(code, `page:${path}`, e);
      throw new ValidationError(`Trang của extension "${a.def.manifest.name}" gặp lỗi và không hiển thị được.`);
    }
  }

  async runJob(entry: { code: string; job: ExtensionJob; active: ActiveExtension }): Promise<void> {
    try {
      await withTimeout(() => entry.job.handler(this.ctxOf(entry.active)), 60_000);
    } catch (e) {
      this.fail(entry.code, `job:${entry.job.name}`, e);
      throw e;
    }
  }

  /** Ghi lỗi đã gom vào nhật ký (nhật ký `log` của extension không ghi ở đây). Gọi cuối giao dịch; lỗi ghi nhật ký không được làm hỏng thao tác chính. */
  async flush(): Promise<void> {
    const rows = this.errors.splice(0).filter((e) => e.hook !== 'log');
    for (const e of rows.slice(0, 50)) {
      try {
        await this.db.query('SAVEPOINT ext_log');
        await this.db.query('INSERT INTO extension_error_log(tenant_id,extension_code,hook,message) VALUES ($1,$2,$3,$4)', [this.tenantId, e.code, e.hook, e.message.slice(0, 1000)]);
        await this.db.query('RELEASE SAVEPOINT ext_log');
      } catch {
        await this.db.query('ROLLBACK TO SAVEPOINT ext_log').catch(() => undefined);
      }
    }
  }
}

/** Gắn extension của cửa hàng vào ngữ cảnh dịch vụ (và nối hook giá/cọc). Gói không có `extensions` thì không làm gì. */
export async function attachExtensions(ctx: ServiceCtx): Promise<ServiceCtx> {
  const { active, skipped } = await loadActiveExtensions(ctx.db, ctx.features);
  if (active.length === 0 && skipped.length === 0) return ctx;
  const host = new ExtensionHost(ctx.db, ctx.tenantId, ctx.timezone ?? 'Asia/Ho_Chi_Minh', active, skipped);
  ctx.ext = host;
  ctx.pricingHook = host.pricingHook() ?? ctx.pricingHook;
  ctx.depositHook = host.depositHook() ?? ctx.depositHook;
  return ctx;
}

/** Chạy một việc với extension đã gắn và ghi nhật ký lỗi extension ở cuối. */
export async function withExtensions<T>(ctx: ServiceCtx, fn: (ctx: ServiceCtx) => Promise<T>): Promise<T> {
  await attachExtensions(ctx);
  try {
    return await fn(ctx);
  } finally {
    await ctx.ext?.flush();
  }
}

export interface ExtensionInfo { code: string; name: string; version: string; description: string | null; hooks: string[]; reports: number; pages: number; jobs: number; enabled: boolean; skippedReason: string | null }

/** Extension của cửa hàng (chỉ xem): đã bật, và lý do nếu bị bỏ qua. */
export async function listTenantExtensions(ctx: ServiceCtx): Promise<ExtensionInfo[]> {
  const rows = (await ctx.db.query('SELECT extension_code, enabled FROM tenant_extension ORDER BY extension_code')).rows as Row[];
  const skipped = new Map((ctx.ext?.skipped ?? []).map((s) => [s.code, s.reason]));
  const activeCodes = new Set((ctx.ext?.active ?? []).map((a) => a.def.manifest.code));
  return rows.map((r) => {
    const d = getExtension(r.extension_code);
    return {
      code: r.extension_code, name: d?.manifest.name ?? r.extension_code, version: d?.manifest.version ?? '?', description: d?.manifest.description ?? null, hooks: d?.manifest.hooks ?? [],
      reports: d?.reports?.length ?? 0, pages: d?.pages?.length ?? 0, jobs: d?.jobs?.length ?? 0, enabled: r.enabled && activeCodes.has(r.extension_code),
      skippedReason: r.enabled ? skipped.get(r.extension_code) ?? (ctx.features['extensions'] ? null : 'Gói hiện tại không có tính năng extension.') : null,
    };
  });
}

export interface ExtensionJobsResult { ran: number; failed: number; skipped: number }

/**
 * Chạy các tác vụ nền do extension đăng ký khi đến lịch (mỗi N phút, hoặc mỗi ngày vào giờ HH:MM theo múi giờ cửa hàng).
 * Mỗi tác vụ ghi một dòng `job_run` riêng (`ext:<mã>:<tên>`); tác vụ lỗi không chặn tác vụ khác.
 */
export async function runExtensionJobs(ctx: ServiceCtx, now: Date): Promise<ExtensionJobsResult> {
  const out: ExtensionJobsResult = { ran: 0, failed: 0, skipped: 0 };
  const host = ctx.ext;
  if (!host) return out;
  const tz = ctx.timezone ?? 'Asia/Ho_Chi_Minh';
  for (const entry of host.jobs()) {
    const name = `ext:${entry.code}:${entry.job.name}`;
    const last: Date | null = (await ctx.db.query(`SELECT max(started_at) AS t FROM job_run WHERE name=$1 AND ok`, [name])).rows[0]?.t ?? null;
    const s = entry.job.schedule;
    let due: boolean;
    if ('everyMinutes' in s) due = !last || now.getTime() - last.getTime() >= s.everyMinutes * 60_000;
    else {
      const at = zonedTimeToUtc(`${localDateKey(now, tz)}T${s.dailyAt}`, tz);
      due = !!at && now.getTime() >= at.getTime() && (!last || last.getTime() < at.getTime());
    }
    if (!due) { out.skipped++; continue; }
    let ok = true;
    let detail: object = {};
    try {
      await ctx.db.query('SAVEPOINT ext_job');
      await host.runJob(entry);
      await ctx.db.query('RELEASE SAVEPOINT ext_job');
    } catch (e) {
      ok = false;
      detail = { error: e instanceof Error ? e.message : String(e) };
      await ctx.db.query('ROLLBACK TO SAVEPOINT ext_job').catch(() => undefined); // việc dở dang của tác vụ lỗi được hoàn lại
    }
    await ctx.db.query('INSERT INTO job_run(tenant_id,name,started_at,ok,detail) VALUES ($1,$2,$3,$4,$5)', [ctx.tenantId, name, now, ok, JSON.stringify(detail)]);
    if (ok) out.ran++; else out.failed++;
  }
  return out;
}
