import { resolve } from 'node:path';
import { LocalFsStorage, type JobDeps } from '@rentpro/db';
import { keyRingFromEnv } from '@rentpro/tenancy';
import { sharedProvidersFromEnv } from '@rentpro/notifications';
import pg from 'pg';

export { sharedProvidersFromEnv };
type Env = Record<string, string | undefined>;

/** Mẫu địa chỉ cửa hàng, VD "https://{slug}.rentpro.vn" hoặc "http://{slug}.localhost:3000"; dùng dựng liên kết thanh toán gửi khách. */
export function publicUrlFrom(env: Env): ((slug: string) => string) | undefined {
  const tpl = env.PUBLIC_URL_TEMPLATE;
  return tpl ? (slug) => tpl.replace('{slug}', slug) : undefined;
}

export function depsFromEnv(env: Env = process.env): JobDeps & { close(): Promise<void> } {
  const app = env.DATABASE_URL;
  const admin = env.DATABASE_PLATFORM_URL;
  if (!app || !admin) throw new Error('Thiếu DATABASE_URL (role ứng dụng) hoặc DATABASE_PLATFORM_URL (role quản trị, chỉ để liệt kê tenant).');
  const appPool = new pg.Pool({ connectionString: app, max: 4 });
  const adminPool = new pg.Pool({ connectionString: admin, max: 2 });
  return {
    appPool, adminPool, keyRing: keyRingFromEnv(env as Record<string, string | undefined>),
    storage: new LocalFsStorage(env.STORAGE_DIR ?? resolve(process.cwd(), '../../.data/storage')),
    notify: { shared: sharedProvidersFromEnv(env) },
    publicUrl: publicUrlFrom(env), paySecret: env.FILE_URL_SECRET ?? env.AUTH_SECRET,
    close: async () => { await appPool.end(); await adminPool.end(); },
  };
}
