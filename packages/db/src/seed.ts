import pg from 'pg';
import { hashPassword } from '@rentpro/core';
import { FEATURE_KEYS, type FeatureKey } from '@rentpro/tenancy';

export const DEMO_PASSWORD = 'Demo@12345678';

const only = (keys: FeatureKey[]) => Object.fromEntries(keys.map((k) => [k, true]));
const BASIC: FeatureKey[] = ['inventory', 'inventory.barcode', 'inventory.stocktake', 'booking', 'contract', 'deposit', 'pricing', 'payments', 'notify.email', 'maintenance', 'reports.basic'];
const PRO: FeatureKey[] = [...BASIC, 'booking.timeline', 'notify.sms', 'notify.zalo', 'maintenance.usage_based', 'reports.advanced', 'reports.roi', 'custom_fields', 'multi_branch', 'contract.e_signature'];
const ENT: FeatureKey[] = [...FEATURE_KEYS];

/** Seed cố định, chạy lặp lại được (ON CONFLICT). Dùng role quản trị. */
export async function seed(adminUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const plans = [
      ['basic', 'Cơ bản', 299000, 2990000, only(BASIC), { branches: 1, users: 3, equipment: 300, messages_per_month: 200, storage_mb: 1024 }],
      ['pro', 'Chuyên nghiệp', 799000, 7990000, only(PRO), { branches: 3, users: 10, equipment: 2000, messages_per_month: 2000, storage_mb: 10240 }],
      ['enterprise', 'Doanh nghiệp', 0, 0, only(ENT), {}],
    ] as const;
    const planId: Record<string, string> = {};
    for (const [code, name, pm, py, features, limits] of plans) {
      const r = await c.query(
        `INSERT INTO plan(code,name,price_month,price_year,features,limits) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, price_month=EXCLUDED.price_month,
           price_year=EXCLUDED.price_year, features=EXCLUDED.features, limits=EXCLUDED.limits RETURNING id`,
        [code, name, pm, py, JSON.stringify(features), JSON.stringify(limits)],
      );
      planId[code] = r.rows[0].id;
    }
    const pw = await hashPassword(DEMO_PASSWORD);
    await c.query(
      `INSERT INTO platform_user(email,password_hash,role) VALUES ('admin@rentpro.local',$1,'SUPER_ADMIN') ON CONFLICT (email) DO NOTHING`,
      [pw],
    );
    const t = await c.query(
      `INSERT INTO tenant(slug,name,plan_id,status) VALUES ('demo','Cửa hàng Demo',$1,'ACTIVE')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [planId.pro],
    );
    const tenantId = t.rows[0].id as string;
    for (const [role, name] of [['OWNER', 'Chủ cửa hàng'], ['MANAGER', 'Quản lý'], ['STAFF', 'Nhân viên quầy'], ['TECHNICIAN', 'Kỹ thuật']] as const) {
      await c.query(
        `INSERT INTO app_user(tenant_id,email,name,password_hash,role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,email) DO NOTHING`,
        [tenantId, `${role.toLowerCase()}@demo.local`, name, pw, role],
      );
    }
  } finally {
    await c.end();
  }
}
