import { NextResponse, type NextRequest } from 'next/server';

/**
 * Trang chủ của tên miền gốc (không phải cửa hàng nào) là trang giới thiệu + bảng giá + đăng ký.
 * Cửa hàng ở subdomain/tên miền riêng, và chế độ dedicated, giữ nguyên hành vi cũ.
 * Không dùng import từ lib/marketing (có next/headers) vì middleware chạy ở Edge.
 */
export function middleware(req: NextRequest) {
  if (process.env.DEPLOY_MODE === 'dedicated') return NextResponse.next();
  const host = (req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || '').toLowerCase().split(':')[0] ?? '';
  const base = (process.env.BASE_DOMAIN ?? 'localhost').toLowerCase();
  if (req.nextUrl.pathname === '/' && (host === base || host === `www.${base}`)) {
    const url = req.nextUrl.clone();
    url.pathname = '/gioi-thieu';
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/'] };
