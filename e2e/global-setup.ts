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
  await seedShop(pool, tenantId);

  // Cửa hàng gói Cơ bản (không có timeline) để kiểm tra cờ tính năng theo gói
  const basic = await createTenant(pool, actor, { slug: `${slug}-basic`, name: 'Cửa hàng E2E Cơ bản', planCode: 'basic', ownerEmail: 'owner@e2e-basic.local', ownerName: 'Chủ cơ bản' });
  await setTenantStatus(pool, actor, basic.tenantId, 'ACTIVE');
  await pool.query('UPDATE app_user SET password_hash=$2 WHERE tenant_id=$1', [basic.tenantId, hash]);
  await pool.end();
  process.env.E2E_BASIC_URL = `http://${slug}-basic.localhost:3000`;
  process.env.E2E_TENANT_URL = `http://${slug}.localhost:3000`;
  process.env.E2E_TENANT_ID = tenantId;
}

/** Dữ liệu nền cho E2E đặt lịch: 1 mẫu 3 chiếc (đệm 2 giờ), 1 mẫu theo số lượng, giá, 2 khách. */
async function seedShop(pool: ReturnType<typeof createPool>, tenantId: string) {
  const one = async (sql: string, args: unknown[]) => (await pool.query(sql, args)).rows[0].id as string;
  const list = await one("INSERT INTO price_list(tenant_id,name,is_default) VALUES ($1,'Giá niêm yết',true) RETURNING id", [tenantId]);
  const cam = await one("INSERT INTO equipment_model(tenant_id,name,barcode_prefix,buffer_minutes) VALUES ($1,'Sony A7 E2E','CAM',120) RETURNING id", [tenantId]);
  const cable = await one("INSERT INTO equipment_model(tenant_id,name,tracked,stock_qty) VALUES ($1,'Cáp HDMI E2E',false,10) RETURNING id", [tenantId]);
  await pool.query('INSERT INTO price_rule(tenant_id,price_list_id,model_id,hour_price,day_price,week_price,month_price) VALUES ($1,$2,$3,100000,500000,2500000,NULL)', [tenantId, list, cam]);
  await pool.query('INSERT INTO price_rule(tenant_id,price_list_id,model_id,day_price) VALUES ($1,$2,$3,50000)', [tenantId, list, cable]);
  for (let i = 1; i <= 3; i++) {
    await pool.query("INSERT INTO equipment_unit(tenant_id,model_id,barcode) VALUES ($1,$2,$3)", [tenantId, cam, `CAM-00000${i}`]);
  }
  await pool.query("INSERT INTO barcode_counter(tenant_id,prefix,last_value) VALUES ($1,'CAM',3)", [tenantId]);
  await pool.query("INSERT INTO customer(tenant_id,name,phone) VALUES ($1,'Khách Đặt A','0911000001'), ($1,'Khách Đặt B','0911000002')", [tenantId]);
}
