import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { hashPassword, verifyPassword, type TenantRole } from '@rentpro/core';
import { withTenantId } from '@rentpro/db';
import { pool } from './lib/db';
import { tenantFromHost } from './lib/tenant';

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
        const tenant = await tenantFromHost(request.headers.get('host') ?? '');
        if (!tenant || tenant.status === 'SUSPENDED' || tenant.status === 'DELETED') return null;
        const user = await withTenantId(pool(), tenant.id, async (db) =>
          (await db.query('SELECT id, name, email, password_hash, role, active FROM app_user WHERE email = $1', [parsed.data.email.toLowerCase()])).rows[0],
        );
        const ok = await verifyPassword(user?.password_hash ?? (await dummyHash), parsed.data.password);
        if (!user || !user.active || !ok) return null;
        return { id: user.id, name: user.name, email: user.email, tenantId: tenant.id, role: user.role as TenantRole };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.uid = user.id;
        token.tenantId = (user as { tenantId: string }).tenantId;
        token.role = (user as { role: TenantRole }).role;
      }
      return token;
    },
    session({ session, token }) {
      Object.assign(session.user, { id: token.uid, tenantId: token.tenantId, role: token.role });
      return session;
    },
  },
});
