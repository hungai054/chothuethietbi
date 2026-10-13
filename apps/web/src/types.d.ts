import type { TenantRole } from '@rentpro/core';

declare module 'next-auth' {
  interface Session {
    user: { id: string; tenantId: string; role: TenantRole; name?: string | null; email?: string | null };
  }
}
declare module '@auth/core/jwt' {
  interface JWT { uid?: string; tenantId?: string; role?: TenantRole }
}
