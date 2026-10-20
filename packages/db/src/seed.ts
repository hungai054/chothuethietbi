import pg from 'pg';
import { hashPassword } from '@rentpro/core';
import { FEATURE_KEYS, type FeatureKey } from '@rentpro/tenancy';
import { seedDemoActivity } from './seed-activity';

export const DEMO_PASSWORD = 'Demo@12345678';

const only = (keys: FeatureKey[]) => Object.fromEntries(keys.map((k) => [k, true]));
const BASIC: FeatureKey[] = ['inventory', 'customers', 'inventory.barcode', 'inventory.stocktake', 'booking', 'contract', 'deposit', 'pricing', 'payments', 'notify.email', 'maintenance', 'reports.basic', 'audit.log'];
const PRO: FeatureKey[] = [...BASIC, 'booking.timeline', 'maintenance.usage_based', 'reports.advanced', 'reports.roi', 'custom_fields', 'multi_branch', 'contract.e_signature'];
/**
 * Tính năng đang TẮT ở mọi gói để đơn giản hóa sản phẩm (mã, dữ liệu và test vẫn giữ nguyên, bật lại bằng cách xóa khỏi danh sách này rồi chạy
 * `pnpm db:migrate`; hoặc bật riêng cho một cửa hàng bằng ghi đè cờ ở cổng quản trị). Menu, trang cài đặt, dịch vụ và hàng đợi gửi đều tự theo cờ.
 */
export const DISABLED_FEATURES: readonly FeatureKey[] = ['notify.sms', 'notify.zalo'];
const ENT: FeatureKey[] = FEATURE_KEYS.filter((k) => !DISABLED_FEATURES.includes(k));

/**
 * Chế độ triển khai thật: `NODE_ENV=production` hoặc `SEED_DEMO=false`. KHÔNG tạo cửa hàng demo, tài khoản `*@demo.local` hay đơn mẫu;
 * tài khoản quản trị nền tảng lấy từ PLATFORM_ADMIN_EMAIL + PLATFORM_ADMIN_PASSWORD (bắt buộc, ít nhất 12 ký tự, không dùng mật khẩu mẫu).
 */
export const isProductionSeed = (env: Record<string, string | undefined> = process.env) => env.NODE_ENV === 'production' || env.SEED_DEMO === 'false';

export function platformAdminFromEnv(env: Record<string, string | undefined> = process.env): { email: string; password: string } {
  const email = env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.PLATFORM_ADMIN_PASSWORD ?? '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('Triển khai thật cần PLATFORM_ADMIN_EMAIL hợp lệ để tạo tài khoản quản trị đầu tiên.');
  if (password.length < 12 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) throw new Error('PLATFORM_ADMIN_PASSWORD phải có ít nhất 12 ký tự, gồm cả chữ và số.');
  if (password === DEMO_PASSWORD) throw new Error('PLATFORM_ADMIN_PASSWORD không được dùng mật khẩu mẫu.');
  return { email, password };
}

/** Seed cố định, chạy lặp lại được (ON CONFLICT). Dùng role quản trị. */
export async function seed(adminUrl: string): Promise<void> {
  const production = isProductionSeed();
  const prodAdmin = production ? platformAdminFromEnv() : null; // báo lỗi sớm, trước khi chạm DB
  if (!production && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(adminUrl).hostname)) {
    console.warn('CẢNH BÁO: đang nạp dữ liệu MẪU (tài khoản *@demo.local, admin@rentpro.local với mật khẩu công khai) vào máy chủ không phải localhost. Triển khai thật hãy đặt NODE_ENV=production hoặc SEED_DEMO=false cùng PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD.');
  }
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
    if (prodAdmin) {
      await c.query(
        `INSERT INTO platform_user(email,password_hash,role) VALUES ($1,$2,'SUPER_ADMIN') ON CONFLICT (email) DO NOTHING`,
        [prodAdmin.email, await hashPassword(prodAdmin.password)],
      );
      return; // triển khai thật: chỉ gói + tài khoản quản trị, không có dữ liệu mẫu
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
    await seedDemoData(c, tenantId);
  } finally {
    await c.end();
  }
  // Đơn mẫu đi qua service nghiệp vụ; lỗi ở đây không được làm hỏng bước seed nền
  try {
    const n = await seedDemoActivity(adminUrl);
    if (n) console.log(`seed: đã tạo ${n} đơn mẫu cho cửa hàng demo`);
  } catch (e) {
    console.warn('seed: bỏ qua đơn mẫu:', e instanceof Error ? e.message : e);
  }
}

/** Dữ liệu mẫu nhỏ cho cửa hàng demo (ngành máy ảnh/quay phim). Chỉ chèn khi cửa hàng chưa có mẫu thiết bị nào. */
async function seedDemoData(c: pg.Client, tenantId: string): Promise<void> {
  if ((await c.query('SELECT 1 FROM equipment_model WHERE tenant_id=$1 LIMIT 1', [tenantId])).rowCount) return;
  const one = async (sql: string, args: unknown[]) => (await c.query(sql, args)).rows[0].id as string;

  let branch = (await c.query('SELECT id FROM branch WHERE tenant_id=$1 LIMIT 1', [tenantId])).rows[0]?.id as string | undefined;
  branch ??= await one("INSERT INTO branch(tenant_id,name) VALUES ($1,'Chi nhánh chính') RETURNING id", [tenantId]);

  const cat: Record<string, string> = {};
  for (const n of ['Máy ảnh', 'Ống kính', 'Âm thanh', 'Ánh sáng']) cat[n] = await one('INSERT INTO category(tenant_id,name) VALUES ($1,$2) RETURNING id', [tenantId, n]);

  const list = await one("INSERT INTO price_list(tenant_id,name,is_default) VALUES ($1,'Giá niêm yết',true) RETURNING id", [tenantId]);
  // [tên, hãng, danh mục, tiền tố, số lượng, giá giờ, ngày, tuần, tháng, giá trị bồi thường]
  const models: [string, string, string, string, number, number, number, number, number, number][] = [
    ['Sony A7 IV', 'Sony', 'Máy ảnh', 'CAM', 5, 150_000, 700_000, 3_500_000, 11_000_000, 55_000_000],
    ['Canon EOS R6', 'Canon', 'Máy ảnh', 'CAM', 3, 130_000, 600_000, 3_000_000, 9_500_000, 45_000_000],
    ['Sony FE 24-70mm f/2.8 GM', 'Sony', 'Ống kính', 'LEN', 4, 90_000, 400_000, 2_000_000, 6_000_000, 38_000_000],
    ['Rode Wireless GO II', 'Rode', 'Âm thanh', 'MIC', 6, 40_000, 150_000, 750_000, 2_400_000, 8_000_000],
    ['Godox SL-60W', 'Godox', 'Ánh sáng', 'LGT', 4, 50_000, 200_000, 1_000_000, 3_200_000, 5_000_000],
  ];
  const counters = new Map<string, number>();
  for (const [name, brand, category, prefix, qty, hour, day, week, month, comp] of models) {
    const m = await one(
      'INSERT INTO equipment_model(tenant_id,category_id,name,brand,barcode_prefix,compensation_value,buffer_minutes) VALUES ($1,$2,$3,$4,$5,$6,120) RETURNING id',
      [tenantId, cat[category], name, brand, prefix, comp]);
    await c.query('INSERT INTO price_rule(tenant_id,price_list_id,model_id,hour_price,day_price,week_price,month_price,min_hours) VALUES ($1,$2,$3,$4,$5,$6,$7,3)',
      [tenantId, list, m, hour, day, week, month]);
    for (let i = 0; i < qty; i++) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      const code = `${prefix}-${String(n).padStart(6, '0')}`;
      const u = await one(
        "INSERT INTO equipment_unit(tenant_id,model_id,branch_id,serial,barcode,purchase_price,compensation_value) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [tenantId, m, branch, `${prefix}${1000 + n}`, code, Math.round(comp * 0.9), comp]);
      await c.query("INSERT INTO unit_status_log(tenant_id,unit_id,to_status,reason) VALUES ($1,$2,'AVAILABLE','Dữ liệu mẫu')", [tenantId, u]);
    }
  }
  for (const [prefix, n] of counters) await c.query('INSERT INTO barcode_counter(tenant_id,prefix,last_value) VALUES ($1,$2,$3)', [tenantId, prefix, n]);

  const group = await one("INSERT INTO customer_group(tenant_id,name,discount_percent,price_list_id) VALUES ($1,'Đối tác',10,$2) RETURNING id", [tenantId, list]);
  const customers: [string, string, string | null, string | null][] = [
    ['Nguyễn Văn An', '0901234567', 'an.nguyen@example.com', null],
    ['Trần Thị Bích', '0912345678', null, null],
    ['Lê Hoàng Cường', '0987654321', 'cuong.le@example.com', null],
    ['Phạm Minh Đức', '0933221100', null, group],
    ['Studio Ánh Sáng', '0944556677', 'booking@anhsang.example.com', group],
  ];
  for (const [name, phone, email, g] of customers)
    await c.query('INSERT INTO customer(tenant_id,name,phone,email,group_id) VALUES ($1,$2,$3,$4,$5)', [tenantId, name, phone, email, g]);
}
