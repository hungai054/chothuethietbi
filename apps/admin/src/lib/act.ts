import { redirect } from 'next/navigation';
import { CouponError } from '@rentpro/core';
import { PlatformError } from '@rentpro/db';

const isRedirect = (e: unknown) => typeof e === 'object' && e !== null && 'digest' in e && String((e as { digest: unknown }).digest).startsWith('NEXT_REDIRECT');

/** Chạy một thao tác quản trị: lỗi nghiệp vụ → quay lại trang với thông báo; thành công → chuyển tới `ok` (mặc định quay lại trang kèm ?ok=1). */
export async function act(back: string, fn: () => Promise<string | void>): Promise<never> {
  let to: string | void;
  try {
    to = await fn();
  } catch (e) {
    if (isRedirect(e)) throw e;
    if (e instanceof PlatformError || e instanceof CouponError) redirect(`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  return redirect(to || `${back}${back.includes('?') ? '&' : '?'}ok=1`);
}

export const vnd = (n: number | string) => new Intl.NumberFormat('vi-VN').format(Number(n)) + ' đ';
export const fmtDate = (d: Date | string | null) => (d ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d)) : '—');
