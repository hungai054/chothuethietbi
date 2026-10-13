import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createPool, getPlatformUser, type PlatformUser } from '@rentpro/db';
import { platformCan, signToken, verifyToken, type PlatformPermission } from '@rentpro/core';

type Pool = ReturnType<typeof createPool>;
const g = globalThis as unknown as { __platformPool?: Pool };

export const db = (): Pool =>
  (g.__platformPool ??= createPool(process.env.DATABASE_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5432/rentpro'));

const secret = () => {
  const s = process.env.ADMIN_SECRET;
  if (!s) throw new Error('Thiếu ADMIN_SECRET');
  return s;
};

const SESSION = 'admin_session';
const PENDING = 'admin_pending';
const SESSION_TTL = 60 * 60 * 8;
const PENDING_TTL = 60 * 5;

const cookieOpts = (maxAge: number) => ({ httpOnly: true, sameSite: 'strict' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge });

/** Sau bước mật khẩu, trước bước TOTP: chưa phải phiên đăng nhập. */
export async function setPending(userId: string) {
  (await cookies()).set(PENDING, signToken({ uid: userId, k: 'pending' }, secret(), PENDING_TTL), cookieOpts(PENDING_TTL));
}

export async function getPendingUser(): Promise<PlatformUser | null> {
  const t = (await cookies()).get(PENDING)?.value;
  const p = t ? verifyToken<{ uid: string; k: string }>(t, secret()) : null;
  return p?.k === 'pending' ? getPlatformUser(db(), p.uid) : null;
}

export async function startSession(userId: string) {
  const c = await cookies();
  c.delete(PENDING);
  c.set(SESSION, signToken({ uid: userId, k: 'session' }, secret(), SESSION_TTL), cookieOpts(SESSION_TTL));
}

export async function endSession() {
  const c = await cookies();
  c.delete(SESSION);
  c.delete(PENDING);
}

export async function currentUser(): Promise<PlatformUser | null> {
  const t = (await cookies()).get(SESSION)?.value;
  const p = t ? verifyToken<{ uid: string; k: string }>(t, secret()) : null;
  if (p?.k !== 'session') return null;
  const u = await getPlatformUser(db(), p.uid); // đọc lại: khóa tài khoản có hiệu lực ngay
  return u?.totp_enabled ? u : null;
}

export async function requireUser(): Promise<PlatformUser> {
  const u = await currentUser();
  if (!u) redirect('/login');
  return u;
}

export async function requireCan(p: PlatformPermission): Promise<PlatformUser> {
  const u = await requireUser();
  if (!platformCan(u.role, p)) throw new Error('Bạn không có quyền thực hiện thao tác này.');
  return u;
}

export const actorOf = (u: PlatformUser) => ({ id: u.id, email: u.email });

// Chặn dò mật khẩu: tối đa 5 lần sai / 15 phút / email (trong bộ nhớ; bản nhiều instance cần chuyển sang DB/Redis).
const fails = new Map<string, number[]>();
export function loginAllowed(key: string, now = Date.now()): boolean {
  const recent = (fails.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
  fails.set(key, recent);
  return recent.length < 5;
}
export const recordLoginFailure = (key: string) => fails.set(key, [...(fails.get(key) ?? []), Date.now()]);
export const clearLoginFailures = (key: string) => fails.delete(key);

// Thông báo một lần (VD mật khẩu tạm của chủ cửa hàng): cookie httpOnly sống 30 giây, không đặt vào URL.
const FLASH = 'admin_flash';
export async function setFlash(v: Record<string, string>) {
  (await cookies()).set(FLASH, signToken(v, secret(), 30), cookieOpts(30));
}
export async function readFlash<T extends Record<string, string>>(): Promise<T | null> {
  const t = (await cookies()).get(FLASH)?.value;
  return t ? verifyToken<T>(t, secret()) : null;
}
