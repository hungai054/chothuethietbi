import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { hashPassword, verifyPassword, verifyToken, type TenantRole } from '@rentpro/core';
import { withTenantId } from '@rentpro/db';
import { pool } from './lib/db';
import { hostOf, tenantFromHost } from './lib/tenant';

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

// Băm giả để thời gian phản hồi không lộ email có tồn tại hay không.
const dummyHash = hashPassword('khong-ton-tai-0000');

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: 'jwt', maxAge: 60 * 60 * 12 },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      async authorize(raw, request) {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) return null;
        const tenant = await tenantFromHost(hostOf(request.headers));
        if (!tenant || tenant.status === 'SUSPENDED' || tenant.status === 'DELETED') return null;
        const user = await withTenantId(pool(), tenant.id, async (db) =>
          (await db.query('SELECT id, name, email, password_hash, role, active FROM app_user WHERE email = $1', [parsed.data.email.toLowerCase()])).rows[0],
        );
        const ok = await verifyPassword(user?.password_hash ?? (await dummyHash), parsed.data.password);
        if (!user || !user.active || !ok) return null;
        return { id: user.id, name: user.name, email: user.email, tenantId: tenant.id, role: user.role as TenantRole };
      },
    }),
    // Đăng nhập thay từ cổng quản trị: token ký ngắn hạn + phiên hỗ trợ còn hiệu lực trong DB của tenant này.
    Credentials({
      id: 'support',
      async authorize(raw, request) {
        const secret = process.env.SUPPORT_SECRET;
        const token = typeof raw?.token === 'string' ? raw.token : '';
        const claims = secret ? verifyToken<{ sid: string; tid: string }>(token, secret) : null;
        if (!claims) return null;
        const tenant = await tenantFromHost(hostOf(request.headers));
        if (!tenant || tenant.id !== claims.tid || tenant.status === 'DELETED') return null;
        const row = await withTenantId(pool(), tenant.id, async (db) =>
          (await db.query('SELECT id, platform_user_email FROM support_access WHERE id=$1 AND ended_at IS NULL AND expires_at > now()', [claims.sid])).rows[0],
        );
        if (!row) return null;
        return { id: `support:${row.id}`, name: `Hỗ trợ · ${row.platform_user_email}`, email: row.platform_user_email, tenantId: tenant.id, role: 'MANAGER' as TenantRole, supportAccessId: row.id };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.tenantId = (user as { tenantId: string }).tenantId;
        token.role = (user as { role: TenantRole }).role;
        token.supportAccessId = (user as { supportAccessId?: string }).supportAccessId;
      }
      return token;
    },
    session({ session, token }) {
      Object.assign(session.user, { id: token.uid, tenantId: token.tenantId, role: token.role, supportAccessId: token.supportAccessId });
      return session;
    },
  },
});
