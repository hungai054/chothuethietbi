import type { NotifyEvent } from './template';

export interface QuietHours { enabled: boolean; start: string; end: string }
export interface ReminderConfig {
  beforeDueHours: number; overdueEveryHours: number; overdueMax: number; holdWarnHours: number; debtAfterHours: number;
  events: Record<NotifyEvent, boolean>;
}
export const DEFAULT_QUIET: QuietHours = { enabled: true, start: '21:00', end: '07:00' };
export const DEFAULT_REMINDERS: ReminderConfig = {
  beforeDueHours: 24, overdueEveryHours: 24, overdueMax: 3, holdWarnHours: 6, debtAfterHours: 24,
  events: { BEFORE_DUE: true, DUE: true, OVERDUE: true, DEBT: true, HOLD_EXPIRING: true },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isValidClock = (s: string) => CLOCK.test(s);
const toMin = (hhmm: string) => {
  const m = CLOCK.exec(hhmm);
  if (!m) throw new Error(`Giờ không hợp lệ: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** Phút trong ngày theo múi giờ cửa hàng. */
function localMinutes(d: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  return Number(p.find((x) => x.type === 'hour')!.value) * 60 + Number(p.find((x) => x.type === 'minute')!.value);
}

/**
 * Nếu `now` nằm trong khung giờ nghỉ thì trả thời điểm kết thúc khung (UTC), ngược lại null.
 * Khung có thể vắt qua nửa đêm (21:00 → 07:00). Bắt đầu = kết thúc nghĩa là không có khung.
 */
export function quietWindowEnd(now: Date, tz: string, q: QuietHours): Date | null {
  if (!q.enabled) return null;
  const s = toMin(q.start), e = toMin(q.end);
  if (s === e) return null;
  const m = localMinutes(now, tz);
  const inside = s < e ? m >= s && m < e : m >= s || m < e;
  if (!inside) return null;
  const wait = (e - m + 1440) % 1440;
  const base = new Date(now.getTime());
  base.setUTCSeconds(0, 0);
  return new Date(base.getTime() + wait * 60_000);
}

export interface ReminderSubject {
  status: string; startsAt: Date; endsAt: Date; holdExpiresAt: Date | null; returnedAt: Date | null; balanceOwed: number;
}
export interface DueReminder { event: NotifyEvent; slot: string }

/**
 * Các nhắc nhở đang đến lúc gửi cho một đơn. Mỗi (sự kiện, slot) chỉ phát sinh một lần nhờ khóa idempotency ở tầng lưu;
 * chỉ trả slot MỚI NHẤT nên worker nghỉ lâu rồi chạy lại cũng không dồn một loạt tin cũ.
 */
export function dueReminders(b: ReminderSubject, now: Date, c: ReminderConfig): DueReminder[] {
  const out: DueReminder[] = [];
  const t = now.getTime();
  if (b.status === 'ACTIVE') {
    const end = b.endsAt.getTime();
    if (c.events.BEFORE_DUE && t >= end - c.beforeDueHours * HOUR && t < end) out.push({ event: 'BEFORE_DUE', slot: '1' });
    if (t >= end) {
      const n = Math.floor((t - end) / (c.overdueEveryHours * HOUR));
      if (n === 0 && c.events.DUE) out.push({ event: 'DUE', slot: '1' });
      if (n >= 1 && c.events.OVERDUE && n <= c.overdueMax) out.push({ event: 'OVERDUE', slot: String(n) });
    }
  }
  if (b.status === 'HOLD' && c.events.HOLD_EXPIRING && b.holdExpiresAt) {
    const left = b.holdExpiresAt.getTime() - t;
    if (left > 0 && left <= c.holdWarnHours * HOUR) out.push({ event: 'HOLD_EXPIRING', slot: '1' });
  }
  if (b.status === 'RETURNED' && c.events.DEBT && b.balanceOwed > 0 && b.returnedAt) {
    const from = b.returnedAt.getTime() + c.debtAfterHours * HOUR;
    if (t >= from) out.push({ event: 'DEBT', slot: String(Math.min(4, Math.floor((t - from) / (7 * DAY)) + 1)) });
  }
  return out;
}
