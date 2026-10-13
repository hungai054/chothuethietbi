/**
 * Đổi giờ địa phương theo múi giờ IANA (VD "2026-11-02T08:00" ở Asia/Ho_Chi_Minh) sang thời điểm UTC.
 * Dùng cho ô nhập datetime-local: trình duyệt không gửi múi giờ nên phải hiểu theo múi giờ của cửa hàng.
 */
export function zonedTimeToUtc(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const probe = new Date(asUtc);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || probe.getUTCHours() !== h) return null; // ngày không tồn tại (VD 31/02)
  try {
    // Hai bước lặp để xử lý đúng múi giờ có DST: offset tại thời điểm ước lượng rồi tại thời điểm đã hiệu chỉnh.
    let guess = asUtc - offsetMs(asUtc, timeZone);
    guess = asUtc - offsetMs(guess, timeZone);
    return new Date(guess);
  } catch {
    return null; // múi giờ không hợp lệ
  }
}

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** Định dạng thời điểm UTC thành chuỗi datetime-local theo múi giờ (ngược lại với zonedTimeToUtc). */
export function utcToZonedInput(d: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}
