import { localDateKey } from '../pricing/engine';
import { zonedTimeToUtc } from '../time';

// ===== Kết quả báo cáo dùng chung =====
// Mọi báo cáo (kể cả báo cáo do extension đăng ký) trả cùng một hình dạng để giao diện và xuất Excel dùng chung.
export type ColumnType = 'text' | 'money' | 'int' | 'percent' | 'hours' | 'date';

export interface ReportColumn { key: string; label: string; type: ColumnType }
export type Cell = string | number | null;
export type ReportRow = Record<string, Cell>;

export interface ChartSpec {
  type: 'bar' | 'line';
  /** Cột làm nhãn trục ngang */
  labelKey: string;
  series: { key: string; label: string }[];
}

export interface ReportSection {
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Dòng tổng (cùng khóa cột); không có thì không hiện */
  totals?: ReportRow;
  chart?: ChartSpec;
  note?: string;
}

export interface ReportCard { label: string; value: number | string; type: ColumnType; hint?: string; href?: string; tone?: 'warn' | 'good' }

export interface ReportResult {
  key: string;
  title: string;
  /** Khoảng thời gian áp dụng, dạng chữ để in lên báo cáo/Excel */
  period: string;
  cards?: ReportCard[];
  sections: ReportSection[];
  notes?: string[];
}

export const REPORT_KEYS = ['dashboard', 'revenue', 'debts', 'deposits', 'utilization', 'roi', 'maintenance', 'customers', 'inventory'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

// ===== Bộ lọc =====
export const GROUP_BYS = ['day', 'month', 'model', 'category', 'branch', 'staff'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const GROUP_BY_LABEL: Record<GroupBy, string> = { day: 'Theo ngày', month: 'Theo tháng', model: 'Theo mẫu thiết bị', category: 'Theo danh mục', branch: 'Theo chi nhánh', staff: 'Theo nhân viên tạo đơn' };

export interface ReportFilter {
  /** yyyy-mm-dd theo múi giờ cửa hàng */
  from?: string;
  to?: string;
  branchId?: string | null;
  categoryId?: string | null;
  groupBy?: GroupBy;
}

export class ReportFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportFilterError';
  }
}

export interface ResolvedRange {
  fromKey: string;
  toKey: string;
  /** Thời điểm bắt đầu (00:00 giờ địa phương của ngày `from`) */
  from: Date;
  /** Thời điểm kết thúc, KHÔNG gồm (00:00 giờ địa phương của ngày sau `to`) */
  to: Date;
  days: number;
}

const DAY = 86_400_000;
const KEY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_REPORT_DAYS = 3660;

const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const validKey = (k: string) => {
  if (!KEY.test(k)) return false;
  const d = new Date(`${k}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === k;
};

/**
 * Đổi bộ lọc ngày thành khoảng thời gian UTC theo múi giờ cửa hàng. Ngày bắt đầu và kết thúc đều tính trọn ngày.
 * `defaultRange`: month = từ đầu tháng đến hôm nay; all = toàn bộ lịch sử (dùng cho ROI, khách hàng).
 */
export function resolveRange(f: Pick<ReportFilter, 'from' | 'to'>, timeZone: string, now: Date, defaultRange: 'month' | 'all' = 'month'): ResolvedRange {
  const today = localDateKey(now, timeZone);
  const fromKey = f.from || (defaultRange === 'all' ? '2000-01-01' : `${today.slice(0, 8)}01`);
  const toKey = f.to || today;
  if (!validKey(fromKey)) throw new ReportFilterError('Ngày bắt đầu không hợp lệ (định dạng yyyy-mm-dd).');
  if (!validKey(toKey)) throw new ReportFilterError('Ngày kết thúc không hợp lệ (định dạng yyyy-mm-dd).');
  if (fromKey > toKey) throw new ReportFilterError('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
  const days = Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY) + 1;
  if (days > MAX_REPORT_DAYS && !(defaultRange === 'all' && !f.from)) throw new ReportFilterError('Khoảng thời gian báo cáo tối đa 10 năm.');
  const from = zonedTimeToUtc(`${fromKey}T00:00`, timeZone);
  const to = zonedTimeToUtc(`${addDays(toKey, 1)}T00:00`, timeZone);
  if (!from || !to) throw new ReportFilterError('Không đổi được khoảng thời gian theo múi giờ cửa hàng.');
  return { fromKey, toKey, from, to, days };
}

export const describePeriod = (r: ResolvedRange): string => {
  const f = (k: string) => k.split('-').reverse().join('/');
  return r.fromKey === '2000-01-01' ? `đến ${f(r.toKey)}` : r.fromKey === r.toKey ? f(r.fromKey) : `${f(r.fromKey)} – ${f(r.toKey)}`;
};

export const isGroupBy = (v: unknown): v is GroupBy => (GROUP_BYS as readonly unknown[]).includes(v);
