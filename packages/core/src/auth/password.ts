import { hash, verify } from '@node-rs/argon2';

// argon2id, tham số theo khuyến nghị OWASP (m=19MiB, t=2, p=1)
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function validatePasswordStrength(pw: string): string | null {
  if (pw.length < 10) return 'Mật khẩu phải có ít nhất 10 ký tự.';
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return 'Mật khẩu phải gồm cả chữ và số.';
  return null;
}

export const hashPassword = (pw: string) => hash(pw, OPTS);

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}
