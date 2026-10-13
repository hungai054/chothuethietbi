import { hashPassword } from '@rentpro/core';
import { changePlan, createPool, createTenant, setTenantStatus } from '@rentpro/db';

export const E2E_PASSWORD = 'E2e@12345678';

/** Mỗi lần chạy tạo một tenant mới (gói Chuyên nghiệp) với đủ vai trò, để test chạy lặp được và không đụng dữ liệu demo. */
export default async function globalSetup() {
  const pool = createPool(process.env.E2E_DB_PLATFORM_URL ?? 'postgresql://rentpro_admin:rentpro_admin@localhost:5433/rentpro');
  const actor = { id: '00000000-0000-0000-0000-000000000000', email: 'e2e@rentpro.local' };
  const slug = `e2e-${Date.now()}`;
  const { tenantId } = await createTenant(pool, actor, { slug, name: 'Cửa hàng E2E', planCode: 'basic', ownerEmail: 'owner@e2e.local', ownerName: 'Chủ E2E' });
  await changePlan(pool, actor, tenantId, 'pro');
  await setTenantStatus(pool, actor, tenantId, 'ACTIVE');
  const hash = await hashPassword(E2E_PASSWORD);
  await pool.query('UPDATE app_user SET password_hash=$2 WHERE tenant_id=$1', [tenantId, hash]);
  for (const [role, name] of [['STAFF', 'Nhân viên E2E'], ['TECHNICIAN', 'Kỹ thuật E2E']] as const) {
    await pool.query('INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,$2,$3,$4,$5)', [tenantId, `${role.toLowerCase()}@e2e.local`, name, hash, role]);
  }
  await pool.end();
  process.env.E2E_TENANT_URL = `http://${slug}.localhost:3000`;
  process.env.E2E_TENANT_ID = tenantId;
}
