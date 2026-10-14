/** Định dạng hiển thị theo múi giờ của cửa hàng. */
export const vnd = (n: number) => new Intl.NumberFormat('vi-VN').format(n) + ' đ';

export const fmtDateTime = (d: Date | string, tz: string) =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d));

export const fmtDate = (d: Date | string, tz: string) =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d));
