import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { hashPassword, validateSignup, type SignupInput } from '@rentpro/core';
import { SYSTEM_ACTOR, queueEmail } from './billing';
import { PlatformError, platformAudit, provisionTenant } from './platform';

/** Đăng ký tự phục vụ: nhập thông tin → email xác thực → bấm liên kết mới tạo cửa hàng (không tạo tenant rác khi email sai). */
type Pool = pg.Pool;

export const SIGNUP_TTL_HOURS = 24;
const MAX_REQUESTS_PER_HOUR = 5;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function listSignupPlans(pool: Pool): Promise<{ code: string; name: string; priceMonth: number; priceYear: number; limits: Record<string, number | null>; features: Record<string, boolean> }[]> {
  const r = await pool.query('SELECT code, name, price_month::int AS pm, price_year::int AS py, limits, features FROM plan WHERE NOT is_custom AND price_month > 0 ORDER BY price_month');
  return r.rows.map((x) => ({ code: x.code, name: x.name, priceMonth: x.pm, priceYear: x.py, limits: x.limits, features: x.features }));
}

/** Tạo yêu cầu đăng ký và xếp thư xác thực. Không tiết lộ email đã tồn tại hay chưa. */
export async function requestSignup(pool: Pool, input: SignupInput, deps: { verifyUrl: (token: string) => string; now?: Date }): Promise<void> {
  const now = deps.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const slug = input.slug.trim().toLowerCase();
  const bad = validateSignup({ ...input, email, slug });
  if (bad) throw new PlatformError(bad);

  const plans = await listSignupPlans(pool);
  if (plans.length === 0) throw new PlatformError('Hiện chưa mở đăng ký. Vui lòng liên hệ để được hỗ trợ.');
  const plan = plans.find((p) => p.code === input.planCode) ?? plans[0]!;

  const recent = (await pool.query("SELECT count(*)::int AS n FROM signup_request WHERE email=$1 AND created_at > $2", [email, new Date(now.getTime() - 3_600_000)])).rows[0].n as number;
  if (recent >= MAX_REQUESTS_PER_HOUR) throw new PlatformError('Bạn đã gửi quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau ít phút.');
  if ((await pool.query('SELECT 1 FROM tenant WHERE slug=$1', [slug])).rowCount) throw new PlatformError('Địa chỉ cửa hàng này đã được dùng, vui lòng chọn địa chỉ khác.');
  const held = await pool.query('SELECT 1 FROM signup_request WHERE slug=$1 AND consumed_at IS NULL AND expires_at > $2 AND email <> $3', [slug, now, email]);
  if (held.rowCount) throw new PlatformError('Địa chỉ cửa hàng này đang được giữ cho một đăng ký khác, vui lòng chọn địa chỉ khác.');

  const token = randomBytes(32).toString('base64url');
  const passwordHash = await hashPassword(input.password);
  await pool.query("UPDATE signup_request SET expires_at = $2 WHERE email=$1 AND consumed_at IS NULL AND expires_at > $2", [email, now]); // yêu cầu cũ của cùng email hết hiệu lực
  await pool.query(
    `INSERT INTO signup_request(token_hash,email,owner_name,shop_name,slug,password_hash,plan_code,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [sha(token), email, input.ownerName.trim(), input.shopName.trim(), slug, passwordHash, plan.code, now, new Date(now.getTime() + SIGNUP_TTL_HOURS * 3_600_000)],
  );
  await queueEmail(pool, {
    kind: 'signup.verify', to: email, subject: 'Xác nhận email để tạo cửa hàng trên RentPro',
    body: `Xin chào ${input.ownerName.trim()},\n\nBấm vào liên kết dưới đây để xác nhận email và tạo cửa hàng "${input.shopName.trim()}" (hiệu lực ${SIGNUP_TTL_HOURS} giờ):\n${deps.verifyUrl(token)}\n\nNếu bạn không đăng ký, hãy bỏ qua thư này.`,
  });
}

export interface SignupResult { tenantId: string; slug: string; already: boolean }

/** Bấm liên kết xác thực: tạo cửa hàng dùng thử với mật khẩu chủ đã chọn. Bấm lại không tạo trùng. */
export async function completeSignup(pool: Pool, token: string, now = new Date()): Promise<SignupResult> {
  const req = (await pool.query('SELECT * FROM signup_request WHERE token_hash=$1', [sha(token)])).rows[0];
  if (!req || (!req.consumed_at && req.expires_at.getTime() < now.getTime())) throw new PlatformError('Liên kết xác thực không hợp lệ hoặc đã hết hạn. Vui lòng đăng ký lại.');
  if (req.consumed_at) {
    const t = (await pool.query('SELECT id FROM tenant WHERE slug=$1', [req.slug])).rows[0];
    if (!t) throw new PlatformError('Liên kết xác thực đã được dùng.');
    return { tenantId: t.id, slug: req.slug, already: true };
  }
  const claimed = await pool.query('UPDATE signup_request SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL', [req.id, now]);
  if (!claimed.rowCount) throw new PlatformError('Liên kết xác thực đang được xử lý, vui lòng tải lại trang.');
  try {
    const { tenantId } = await provisionTenant(pool, SYSTEM_ACTOR, { slug: req.slug, name: req.shop_name, planCode: req.plan_code, ownerEmail: req.email, ownerName: req.owner_name }, req.password_hash);
    await platformAudit(pool, SYSTEM_ACTOR, 'tenant.signup', tenantId, { email: req.email, plan: req.plan_code });
    await queueEmail(pool, {
      tenantId, kind: 'signup.welcome', to: req.email, subject: `Chào mừng ${req.shop_name} đến với RentPro`,
      body: `Cửa hàng "${req.shop_name}" đã sẵn sàng. Đăng nhập bằng email ${req.email} và mật khẩu bạn đã đặt. Bạn đang dùng thử miễn phí; vào Cài đặt → Gói dịch vụ để xem hạn dùng thử.`,
    });
    return { tenantId, slug: req.slug, already: false };
  } catch (e) {
    await pool.query('UPDATE signup_request SET consumed_at=NULL WHERE id=$1', [req.id]);
    throw e;
  }
}
