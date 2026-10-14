import type { Adjustment, DepositContext, Permission, Quote, ReportFilter, ReportResult } from '@rentpro/core';
import type { ZodTypeAny } from 'zod';

export type { Adjustment, DepositContext, Permission, Quote, ReportFilter, ReportResult };

/** Phiên bản SDK. Extension khai báo dải phiên bản tương thích; lõi chỉ nạp extension tương thích. */
export const SDK_VERSION = '1.0.0';

// ===== Điểm móc (hooks) =====
export const HOOK_NAMES = [
  'pricing.adjust', 'deposit.suggest', 'booking.beforeCreate', 'booking.afterConfirm', 'booking.afterReturn', 'notification.beforeSend', 'contract.extraVariables',
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** Móc ĐỒNG BỘ (chạy trong vòng tính giá/cọc): không timeout được nên phải nhanh và thuần. */
export const SYNC_HOOKS: readonly HookName[] = ['pricing.adjust', 'deposit.suggest'];

/** Kho khóa–giá trị riêng của extension cho từng cửa hàng (bảng `extension_data`), thay cho việc cho extension tự viết SQL. */
export interface ExtensionStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<{ key: string; value: unknown }[]>;
}

/** Truy vấn CHỈ ĐỌC dữ liệu của chính cửa hàng (một câu SELECT, tham số hóa; RLS vẫn áp dụng). Dùng cho báo cáo riêng. */
export interface ExtensionRead {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface ExtensionContext {
  tenantId: string;
  timezone: string;
  /** Cấu hình riêng của extension cho cửa hàng này, đã kiểm tra theo configSchema */
  config: Record<string, unknown>;
  log(message: string, data?: unknown): void;
  store: ExtensionStore;
  read: ExtensionRead;
}

export interface BookingDraft {
  customerId: string; start: Date; end: Date; status: string; lines: { modelId: string; qty: number }[]; notes?: string | null;
}
export interface BookingInfo { id: string; code: string; customerId: string; start: Date; end: Date; total: number; status: string }
export interface ReturnInfo extends BookingInfo { returnedAt: Date; late: boolean }
export interface OutgoingNotice { channel: 'zalo' | 'sms' | 'email'; to: string; body: string; subject?: string; event: string }
export interface ContractInfo { number: string; bookingCode: string; customerName: string; rentTotal: number; depositRequired: number }

/** Ném lỗi này trong móc `booking.beforeCreate` để TỪ CHỐI thao tác kèm lý do (hiện cho người dùng). Lỗi khác là lỗi của extension. */
export class ExtensionVeto extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionVeto';
  }
}

type Maybe<T> = T | Promise<T>;
export interface Hooks {
  /** Thêm dòng điều chỉnh giá (có nhãn rõ ràng). Không sửa được dòng gốc. */
  'pricing.adjust': (ctx: ExtensionContext, quote: Quote) => Adjustment[];
  /** Trả mức cọc (đồng, số nguyên ≥ 0) thay cho mức gợi ý theo cấu hình. */
  'deposit.suggest': (ctx: ExtensionContext, c: DepositContext & { suggested: number }) => number;
  'booking.beforeCreate': (ctx: ExtensionContext, b: BookingDraft) => Maybe<void>;
  'booking.afterConfirm': (ctx: ExtensionContext, b: BookingInfo) => Maybe<void>;
  'booking.afterReturn': (ctx: ExtensionContext, b: ReturnInfo) => Maybe<void>;
  /** Sửa nội dung tin trước khi gửi; trả null để chặn không gửi. */
  'notification.beforeSend': (ctx: ExtensionContext, m: OutgoingNotice) => Maybe<OutgoingNotice | null>;
  /** Biến bổ sung cho mẫu hợp đồng, dùng dưới dạng `{ext.<tên>}`. */
  'contract.extraVariables': (ctx: ExtensionContext, c: ContractInfo) => Maybe<Record<string, string>>;
}

// ===== Báo cáo, trang, tác vụ nền =====
export interface ExtensionReport {
  key: string;
  title: string;
  description: string;
  /** Quyền cần có để xem (mặc định reports.view) */
  permission?: Permission;
  /** Bộ lọc ngày: month (mặc định) = từ đầu tháng; all = toàn lịch sử; snapshot = không dùng ngày */
  range?: 'month' | 'all' | 'snapshot';
  run(ctx: ExtensionContext, filter: ReportFilter): Promise<ReportResult>;
}

/** Trang riêng trong menu. Trang được mô tả bằng dữ liệu (thẻ + bảng + biểu đồ) và dựng bằng bộ hiển thị chung của hệ thống. */
export interface ExtensionPage {
  path: string;
  title: string;
  permission?: Permission;
  render(ctx: ExtensionContext): Promise<ReportResult>;
}

export type JobSchedule = { everyMinutes: number } | { dailyAt: string };
export interface ExtensionJob {
  name: string;
  schedule: JobSchedule;
  handler(ctx: ExtensionContext): Promise<void>;
}

// ===== Định nghĩa extension =====
export interface ExtensionManifest {
  /** Mã khách hàng/extension: chữ thường, số, gạch ngang. Bảng riêng phải có tiền tố `ext_<mã với _>_` */
  code: string;
  name: string;
  version: string;
  /** Dải phiên bản SDK tương thích, VD "^1.0" */
  sdk: string;
  description?: string;
  /** Các móc sử dụng (khai báo trước để quản trị biết extension can thiệp vào đâu) */
  hooks: HookName[];
  /** Móc BẮT BUỘC: lỗi (không phải ExtensionVeto) ở móc này làm thao tác thất bại thay vì bị bỏ qua */
  required?: HookName[];
  /** Migration riêng: chỉ được tạo bảng `ext_<mã>_*` (có RLS), không sửa/xóa bảng lõi */
  migrations?: { id: string; sql: string }[];
}

export interface ExtensionDefinition {
  manifest: ExtensionManifest;
  /** Kiểm tra cấu hình theo cửa hàng (zod). Không có thì cấu hình phải là đối tượng rỗng. */
  configSchema?: ZodTypeAny;
  hooks?: Partial<Hooks>;
  reports?: ExtensionReport[];
  pages?: ExtensionPage[];
  jobs?: ExtensionJob[];
}

export const defineExtension = (d: ExtensionDefinition): ExtensionDefinition => d;

// ===== Phiên bản =====
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parse = (v: string): [number, number, number] | null => {
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** Hỗ trợ các dải: "^1.2" / "^1.2.3" (cùng bản chính, không thấp hơn), "1.x", ">=1.2". Đủ cho nhu cầu tương thích SDK. */
export function satisfies(range: string, version: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const r = range.trim();
  let m = /^\^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(r);
  if (m) {
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    return v[0] === maj && (v[1] > min || (v[1] === min && v[2] >= pat));
  }
  m = /^(\d+)\.x$/.exec(r);
  if (m) return v[0] === Number(m[1]);
  m = /^>=(\d+)\.(\d+)(?:\.(\d+))?$/.exec(r);
  if (m) {
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
    return v[0] > maj || (v[0] === maj && (v[1] > min || (v[1] === min && v[2] >= pat)));
  }
  return false;
}

export const isValidRange = (r: string) => /^(\^\d+\.\d+(\.\d+)?|\d+\.x|>=\d+\.\d+(\.\d+)?)$/.test(r.trim());

export function checkCompatibility(m: Pick<ExtensionManifest, 'code' | 'sdk'>, sdkVersion = SDK_VERSION): string | null {
  if (!isValidRange(m.sdk)) return `Extension "${m.code}": dải phiên bản SDK "${m.sdk}" không hợp lệ (dùng dạng ^1.0, 1.x hoặc >=1.0).`;
  if (!satisfies(m.sdk, sdkVersion)) return `Extension "${m.code}" cần SDK ${m.sdk} nhưng hệ thống đang dùng SDK ${sdkVersion}. Hãy nâng cấp extension theo docs/CUSTOMIZATION.md.`;
  return null;
}

// ===== Kiểm tra định nghĩa =====
const CODE_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const tablePrefix = (code: string) => `ext_${code.replace(/-/g, '_')}_`;

const FORBIDDEN_SQL = /\b(alter|drop|truncate|grant|revoke|delete|update|insert|copy|call|do)\b/i;

/**
 * Migration của extension chỉ được: CREATE TABLE / CREATE INDEX trên bảng `ext_<mã>_*`, bật RLS và tạo policy cho các bảng đó.
 * Chặn mọi thao tác khác (sửa/xóa bảng lõi, cấp quyền…). Đây là rào chắn chống nhầm lẫn khi review, không thay cho việc xem xét mã.
 */
export function validateMigrationSql(code: string, sql: string): string | null {
  const prefix = tablePrefix(code);
  const statements = sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  if (statements.length === 0) return 'Migration rỗng.';
  const tables = new Set<string>();
  for (const s of statements) {
    const create = /^create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s*\(/i.exec(s);
    if (create) {
      if (!create[1]!.toLowerCase().startsWith(prefix)) return `Chỉ được tạo bảng có tiền tố "${prefix}" (gặp "${create[1]}").`;
      if (!/\btenant_id\b/i.test(s)) return `Bảng ${create[1]} phải có cột tenant_id.`;
      tables.add(create[1]!.toLowerCase());
      continue;
    }
    const idx = /^create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?[a-z0-9_]*\s*on\s+([a-z0-9_]+)/i.exec(s);
    if (idx) { if (!idx[1]!.toLowerCase().startsWith(prefix)) return `Chỉ được tạo chỉ mục trên bảng "${prefix}*".`; continue; }
    const rls = /^alter\s+table\s+([a-z0-9_]+)\s+(enable|force)\s+row\s+level\s+security$/i.exec(s);
    if (rls) { if (!rls[1]!.toLowerCase().startsWith(prefix)) return `Chỉ được bật RLS cho bảng "${prefix}*".`; continue; }
    const pol = /^create\s+policy\s+[a-z0-9_]+\s+on\s+([a-z0-9_]+)\s+using\s*\(\s*tenant_id\s*=\s*app_tenant_id\(\)\s*\)\s*with\s+check\s*\(\s*tenant_id\s*=\s*app_tenant_id\(\)\s*\)$/i.exec(s);
    if (pol) { if (!pol[1]!.toLowerCase().startsWith(prefix)) return `Chỉ được tạo policy cho bảng "${prefix}*".`; continue; }
    if (FORBIDDEN_SQL.test(s)) return `Câu lệnh không được phép trong migration của extension: "${s.slice(0, 60)}…".`;
    return `Câu lệnh không được hỗ trợ: "${s.slice(0, 60)}…". Chỉ CREATE TABLE/INDEX, bật RLS và tạo policy tenant_isolation cho bảng ${prefix}*.`;
  }
  for (const t of tables) {
    if (!statements.some((s) => new RegExp(`^alter\\s+table\\s+${t}\\s+enable\\s+row\\s+level\\s+security$`, 'i').test(s))) return `Bảng ${t} phải bật ROW LEVEL SECURITY.`;
    if (!statements.some((s) => new RegExp(`^create\\s+policy\\s+\\w+\\s+on\\s+${t}\\b`, 'i').test(s))) return `Bảng ${t} phải có policy cách ly theo tenant_id.`;
  }
  return null;
}

/** Danh sách lỗi của một định nghĩa (rỗng = hợp lệ). */
export function validateDefinition(d: ExtensionDefinition): string[] {
  const m = d.manifest;
  const errs: string[] = [];
  if (!CODE_RE.test(m.code)) errs.push(`Mã extension "${m.code}" không hợp lệ (chữ thường, số, gạch ngang; 2–31 ký tự; bắt đầu bằng chữ).`);
  if (!m.name?.trim()) errs.push('Thiếu tên extension.');
  if (!parse(m.version)) errs.push(`Phiên bản "${m.version}" phải có dạng x.y.z.`);
  const compat = checkCompatibility(m);
  if (compat) errs.push(compat);
  for (const h of m.hooks) if (!(HOOK_NAMES as readonly string[]).includes(h)) errs.push(`Móc "${h}" không tồn tại.`);
  for (const h of m.required ?? []) if (!m.hooks.includes(h)) errs.push(`Móc bắt buộc "${h}" phải nằm trong danh sách hooks.`);
  for (const h of m.required ?? []) if (SYNC_HOOKS.includes(h)) errs.push(`Móc đồng bộ "${h}" không đặt bắt buộc được.`);
  const provided = Object.keys(d.hooks ?? {});
  for (const h of provided) if (!m.hooks.includes(h as HookName)) errs.push(`Extension cài đặt móc "${h}" nhưng chưa khai báo trong manifest.hooks.`);
  for (const h of m.hooks) if (!provided.includes(h)) errs.push(`Manifest khai báo móc "${h}" nhưng không cài đặt.`);
  const keys = new Set<string>();
  for (const r of d.reports ?? []) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(r.key)) errs.push(`Khóa báo cáo "${r.key}" không hợp lệ.`);
    if (keys.has(`r:${r.key}`)) errs.push(`Trùng khóa báo cáo "${r.key}".`);
    keys.add(`r:${r.key}`);
  }
  for (const p of d.pages ?? []) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(p.path)) errs.push(`Đường dẫn trang "${p.path}" không hợp lệ.`);
    if (keys.has(`p:${p.path}`)) errs.push(`Trùng đường dẫn trang "${p.path}".`);
    keys.add(`p:${p.path}`);
  }
  for (const j of d.jobs ?? []) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(j.name)) errs.push(`Tên tác vụ "${j.name}" không hợp lệ.`);
    if (keys.has(`j:${j.name}`)) errs.push(`Trùng tên tác vụ "${j.name}".`);
    keys.add(`j:${j.name}`);
    const s = j.schedule;
    if ('everyMinutes' in s ? !(Number.isInteger(s.everyMinutes) && s.everyMinutes >= 5 && s.everyMinutes <= 10_080) : !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.dailyAt)) errs.push(`Lịch của tác vụ "${j.name}" không hợp lệ (mỗi 5–10080 phút, hoặc dailyAt HH:MM).`);
  }
  for (const mig of m.migrations ?? []) {
    const bad = validateMigrationSql(m.code, mig.sql);
    if (bad) errs.push(`Migration "${mig.id}": ${bad}`);
  }
  return errs;
}

// ===== Registry (đăng ký tại build time) =====
const REGISTRY = new Map<string, ExtensionDefinition>();

/** Đăng ký một extension. Định nghĩa sai hoặc không tương thích SDK bị từ chối ngay (không nạp nửa chừng). */
export function registerExtension(d: ExtensionDefinition): void {
  const errs = validateDefinition(d);
  if (errs.length) throw new Error(`Extension "${d.manifest.code}" không hợp lệ:\n- ${errs.join('\n- ')}`);
  if (REGISTRY.has(d.manifest.code)) throw new Error(`Extension "${d.manifest.code}" đã được đăng ký.`);
  REGISTRY.set(d.manifest.code, d);
}
export const getExtension = (code: string) => REGISTRY.get(code);
export const listExtensions = () => [...REGISTRY.values()];
/** Chỉ dùng trong test. */
export const clearRegistry = () => REGISTRY.clear();

// ===== Cấu hình theo cửa hàng =====
export function parseExtensionConfig(d: ExtensionDefinition, raw: unknown): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  const input = raw === null || raw === undefined ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Cấu hình phải là một đối tượng JSON.' };
  if (!d.configSchema) return Object.keys(input).length === 0 ? { ok: true, config: {} } : { ok: false, error: 'Extension này không có cấu hình.' };
  const r = d.configSchema.safeParse(input);
  if (r.success) return { ok: true, config: r.data as Record<string, unknown> };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'cấu hình'}: ${i.message}`).join('; ') };
}

// ===== Cô lập lỗi =====
export class ExtensionTimeoutError extends Error {
  constructor(ms: number) {
    super(`Quá thời gian chờ ${ms} ms`);
    this.name = 'ExtensionTimeoutError';
  }
}

export const HOOK_TIMEOUT_MS = 2000;

/** Chạy một hàm của extension với timeout. Không bắt lỗi (để nơi gọi quyết định bỏ qua hay chặn). */
export async function withTimeout<T>(fn: () => Promise<T> | T, ms = HOOK_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ExtensionTimeoutError(ms)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
