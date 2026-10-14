import { randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type pg from 'pg';
import {
  ENDPOINT_AUTO_DISABLE_AFTER, MAX_ATTEMPTS, generateApiKey, hashApiKey, isPrivateAddress, isWebhookEvent, looksLikeApiKey, newWebhookSecret, retryDelay,
  signWebhook, validateScopes, validateWebhookUrl, type WebhookEvent,
} from '@rentpro/core';
import { decryptSecret, encryptSecret, resolveFeatures, resolveLimits, type ResolvedFeatures, type Limits } from '@rentpro/tenancy';
import { withTenantId } from './client';
import { NotFoundError, ValidationError, audit, guard, need, type ServiceCtx } from './service';

/** API công khai (khóa theo cửa hàng, phạm vi quyền hẹp) và webhook đi (hàng đợi trong DB, ký HMAC, thử lại có giãn cách). Gói Doanh nghiệp (`api`). */
const FEATURE = 'api' as const;

// ===== Khóa API =====
export interface ApiKeyRow { id: string; name: string; prefix: string; scopes: string[]; createdAt: Date; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null }

/** Tạo khóa. Khóa đầy đủ trả về DUY NHẤT một lần; DB chỉ giữ băm. */
export async function createApiKey(ctx: ServiceCtx, i: { name: string; scopes: string[]; expiresAt?: Date | null }): Promise<{ id: string; key: string; prefix: string }> {
  guard(ctx, 'settings.manage', FEATURE, { write: true });
  const name = i.name.trim();
  if (!name || name.length > 80) throw new ValidationError('Tên khóa từ 1 đến 80 ký tự.');
  const bad = validateScopes(i.scopes);
  if (bad) throw new ValidationError(bad);
  if (i.expiresAt && i.expiresAt.getTime() <= Date.now()) throw new ValidationError('Ngày hết hạn của khóa phải ở tương lai.');
  const active = (await ctx.db.query('SELECT count(*)::int AS n FROM api_key WHERE revoked_at IS NULL')).rows[0].n as number;
  if (active >= 20) throw new ValidationError('Tối đa 20 khóa API đang hoạt động. Hãy thu hồi khóa không dùng.');
  const { key, prefix } = generateApiKey((n) => randomBytes(n));
  const id = (await ctx.db.query(
    'INSERT INTO api_key(tenant_id,name,prefix,key_hash,scopes,created_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [ctx.tenantId, name, prefix, hashApiKey(key), [...new Set(i.scopes)], ctx.userId, i.expiresAt ?? null])).rows[0].id as string;
  await audit(ctx, 'api_key.create', 'api_key', id, { name, scopes: i.scopes, prefix });
  return { id, key, prefix };
}

export async function listApiKeys(ctx: ServiceCtx): Promise<ApiKeyRow[]> {
  guard(ctx, 'settings.manage', FEATURE);
  return (await ctx.db.query('SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_key ORDER BY created_at DESC')).rows
    .map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at, revokedAt: r.revoked_at }));
}

export async function revokeApiKey(ctx: ServiceCtx, id: string): Promise<void> {
  guard(ctx, 'settings.manage', FEATURE, { write: true });
  const r = await ctx.db.query('UPDATE api_key SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL RETURNING name', [id]);
  if (!r.rowCount) throw new NotFoundError('khóa API');
  await audit(ctx, 'api_key.revoke', 'api_key', id, { name: r.rows[0].name });
}

export interface ApiPrincipal {
  keyId: string; tenantId: string; scopes: string[];
  status: string; timezone: string; features: ResolvedFeatures; limits: Limits;
}

/**
 * Xác thực khóa API từ header: tra theo băm (hàm SECURITY DEFINER, chưa cần ngữ cảnh tenant), rồi nạp gói/trạng thái của cửa hàng.
 * Trả null cho mọi trường hợp không hợp lệ (sai định dạng, không có, đã thu hồi, hết hạn, cửa hàng bị khóa/xóa) để không phân biệt lý do.
 */
export async function authenticateApiKey(appPool: pg.Pool, key: string): Promise<ApiPrincipal | null> {
  if (!looksLikeApiKey(key)) return null;
  const k = (await appPool.query('SELECT * FROM resolve_api_key($1)', [hashApiKey(key)])).rows[0] as { id: string; tenant_id: string; scopes: string[] } | undefined;
  if (!k) return null;
  return withTenantId(appPool, k.tenant_id, async (db) => {
    const t = (await db.query(
      `SELECT t.status, t.timezone, t.feature_overrides, t.limit_overrides, p.features, p.limits FROM tenant t JOIN plan p ON p.id = t.plan_id`)).rows[0];
    if (!t) return null;
    // Ghi lần dùng cuối nhiều nhất một lần mỗi phút để không biến mọi lời gọi thành một lần ghi
    await db.query("UPDATE api_key SET last_used_at = now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [k.id]);
    return {
      keyId: k.id, tenantId: k.tenant_id, scopes: k.scopes, status: t.status, timezone: t.timezone,
      features: resolveFeatures({ planFeatures: t.features, overrides: t.feature_overrides }), limits: resolveLimits(t.limits, t.limit_overrides),
    };
  });
}

// ===== Webhook: quản lý endpoint =====
export interface WebhookRow { id: string; url: string; description: string | null; events: string[]; active: boolean; consecutiveFailures: number; disabledReason: string | null; createdAt: Date }
export interface UrlPolicy { allowInsecure?: boolean }

const MAX_ENDPOINTS = 10;

function checkEvents(events: string[]): WebhookEvent[] {
  if (events.length === 0) throw new ValidationError('Chọn ít nhất một sự kiện.');
  const bad = events.find((e) => !isWebhookEvent(e));
  if (bad) throw new ValidationError(`Sự kiện không hợp lệ: ${bad}`);
  return [...new Set(events)] as WebhookEvent[];
}

/** Tạo endpoint. Bí mật ký trả về DUY NHẤT một lần (lưu mã hóa bằng khóa chủ). */
export async function createWebhook(ctx: ServiceCtx, i: { url: string; events: string[]; description?: string }, policy: UrlPolicy = {}): Promise<{ id: string; secret: string }> {
  guard(ctx, 'settings.manage', FEATURE, { write: true });
  const badUrl = validateWebhookUrl(i.url, policy);
  if (badUrl) throw new ValidationError(badUrl);
  const events = checkEvents(i.events);
  if ((await ctx.db.query('SELECT count(*)::int AS n FROM webhook_endpoint')).rows[0].n >= MAX_ENDPOINTS) throw new ValidationError(`Tối đa ${MAX_ENDPOINTS} địa chỉ nhận webhook.`);
  const secret = newWebhookSecret((n) => randomBytes(n));
  const id = (await ctx.db.query(
    'INSERT INTO webhook_endpoint(tenant_id,url,description,secret_enc,events,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [ctx.tenantId, i.url.trim(), i.description?.trim() || null, encryptSecret(secret, need(ctx.keyRing, 'MASTER_KEY')), events, ctx.userId])).rows[0].id as string;
  await audit(ctx, 'webhook.create', 'webhook_endpoint', id, { url: i.url.trim(), events });
  return { id, secret };
}

export async function listWebhooks(ctx: ServiceCtx): Promise<WebhookRow[]> {
  guard(ctx, 'settings.manage', FEATURE);
  return (await ctx.db.query('SELECT id, url, description, events, active, consecutive_failures, disabled_reason, created_at FROM webhook_endpoint ORDER BY created_at DESC')).rows
    .map((r) => ({ id: r.id, url: r.url, description: r.description, events: r.events, active: r.active, consecutiveFailures: r.consecutive_failures, disabledReason: r.disabled_reason, createdAt: r.created_at }));
}

export async function setWebhookActive(ctx: ServiceCtx, id: string, active: boolean): Promise<void> {
  guard(ctx, 'settings.manage', FEATURE, { write: true });
  const r = await ctx.db.query(
    'UPDATE webhook_endpoint SET active=$2, consecutive_failures=CASE WHEN $2 THEN 0 ELSE consecutive_failures END, disabled_reason=CASE WHEN $2 THEN NULL ELSE COALESCE(disabled_reason, \'Tắt thủ công\') END WHERE id=$1',
    [id, active]);
  if (!r.rowCount) throw new NotFoundError('địa chỉ webhook');
  await audit(ctx, 'webhook.active', 'webhook_endpoint', id, { active });
}

export async function deleteWebhook(ctx: ServiceCtx, id: string): Promise<void> {
  guard(ctx, 'settings.manage', FEATURE, { write: true });
  const r = await ctx.db.query('DELETE FROM webhook_endpoint WHERE id=$1', [id]);
  if (!r.rowCount) throw new NotFoundError('địa chỉ webhook');
  await audit(ctx, 'webhook.delete', 'webhook_endpoint', id);
}

/** Đổi bí mật ký (bí mật cũ ngừng dùng ngay). Trả bí mật mới một lần. */
export async function rotateWebhookSecret(ctx: ServiceCtx, id: string): Promise<{ secret: string }> {
  guard(ctx, 'settings.manage', FEATURE, { write: true });
  const secret = newWebhookSecret((n) => randomBytes(n));
  const r = await ctx.db.query('UPDATE webhook_endpoint SET secret_enc=$2 WHERE id=$1', [id, encryptSecret(secret, need(ctx.keyRing, 'MASTER_KEY'))]);
  if (!r.rowCount) throw new NotFoundError('địa chỉ webhook');
  await audit(ctx, 'webhook.rotate_secret', 'webhook_endpoint', id);
  return { secret };
}

export interface DeliveryRow { id: string; endpointId: string; url: string; event: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: Date; sentAt: Date | null; nextAttemptAt: Date }

export async function listDeliveries(ctx: ServiceCtx, opts: { endpointId?: string; limit?: number } = {}): Promise<DeliveryRow[]> {
  guard(ctx, 'settings.manage', FEATURE);
  const rows = (await ctx.db.query(
    `SELECT d.id, d.endpoint_id, e.url, d.event, d.status, d.attempts, d.last_status, d.last_error, d.created_at, d.sent_at, d.next_attempt_at
     FROM webhook_delivery d JOIN webhook_endpoint e ON e.id = d.endpoint_id WHERE ($1::uuid IS NULL OR d.endpoint_id=$1) ORDER BY d.created_at DESC LIMIT $2`,
    [opts.endpointId ?? null, Math.min(opts.limit ?? 30, 200)])).rows;
  return rows.map((r) => ({ id: r.id, endpointId: r.endpoint_id, url: r.url, event: r.event, status: r.status, attempts: r.attempts, lastStatus: r.last_status, lastError: r.last_error, createdAt: r.created_at, sentAt: r.sent_at, nextAttemptAt: r.next_attempt_at }));
}

/** Giao lại thủ công một sự kiện thất bại (xếp lại hàng đợi, đặt lại số lần thử). */
export async function redeliver(ctx: ServiceCtx, deliveryId: string): Promise<void> {
  guard(ctx, 'settings.manage', FEATURE, { write: true });
  const r = await ctx.db.query("UPDATE webhook_delivery SET status='PENDING', attempts=0, next_attempt_at=now(), last_error=NULL WHERE id=$1 AND status='FAILED'", [deliveryId]);
  if (!r.rowCount) throw new ValidationError('Chỉ giao lại được sự kiện đã thất bại.');
  await audit(ctx, 'webhook.redeliver', 'webhook_delivery', deliveryId);
}

// ===== Phát sự kiện (outbox cùng giao dịch) =====
/**
 * Xếp sự kiện cho mọi endpoint đang bật và đăng ký sự kiện này, TRONG CÙNG giao dịch với thay đổi nghiệp vụ:
 * giao dịch hoàn tác thì sự kiện cũng mất (không có sự kiện "ma"). Việc gửi do worker làm sau. Gói không có `api` thì bỏ qua.
 */
export async function emitEvent(ctx: ServiceCtx, event: WebhookEvent, data: Record<string, unknown>): Promise<number> {
  if (!ctx.features[FEATURE]) return 0;
  const eps = (await ctx.db.query('SELECT id FROM webhook_endpoint WHERE active AND $1 = ANY(events)', [event])).rows as { id: string }[];
  const createdAt = new Date().toISOString();
  for (const ep of eps) {
    const eventId = randomUUID();
    await ctx.db.query(
      'INSERT INTO webhook_delivery(tenant_id,endpoint_id,event,event_id,payload) VALUES ($1,$2,$3,$4,$5)',
      [ctx.tenantId, ep.id, event, eventId, JSON.stringify({ id: eventId, type: event, createdAt, data })]);
  }
  return eps.length;
}

/** Sự kiện của đơn thuê với dữ liệu gọn, ổn định (không có giấy tờ, không có số điện thoại khách). */
export async function emitBookingEvent(ctx: ServiceCtx, event: WebhookEvent, bookingId: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (!ctx.features[FEATURE]) return;
  const b = (await ctx.db.query('SELECT id, code, status, customer_id, starts_at, ends_at, total FROM booking WHERE id=$1', [bookingId])).rows[0];
  if (!b) return;
  await emitEvent(ctx, event, { booking: { id: b.id, code: b.code, status: b.status, customerId: b.customer_id, startsAt: b.starts_at, endsAt: b.ends_at, total: Number(b.total) }, ...extra });
}

// ===== Gửi =====
export interface WebhookDeps {
  fetchImpl?: typeof fetch;
  /** Trả các địa chỉ IP của host; mặc định dùng DNS hệ thống */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Cho phép http và địa chỉ nội bộ (dev/test) */
  allowInsecure?: boolean;
  timeoutMs?: number;
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

export interface WebhookDispatchResult { sent: number; failed: number; retried: number; disabled: number }

/**
 * Gửi các sự kiện đến hạn. Mỗi lần: kiểm tra địa chỉ đích (DNS phân giải ra IP công cộng; chống DNS rebinding bằng cách kiểm tra ngay lúc gửi),
 * KHÔNG theo chuyển hướng, giới hạn thời gian, ký HMAC kèm timestamp. Thất bại thì thử lại theo lịch tăng dần rồi đánh dấu FAILED;
 * endpoint lỗi liên tiếp quá nhiều thì tự tắt. Mã đã bắt đầu gửi trong giao dịch khóa dòng nên hai worker không gửi trùng.
 */
export async function dispatchWebhooks(ctx: ServiceCtx, now: Date, deps: WebhookDeps = {}, limit = 25): Promise<WebhookDispatchResult> {
  const out: WebhookDispatchResult = { sent: 0, failed: 0, retried: 0, disabled: 0 };
  if (!ctx.features[FEATURE]) return out;
  const doFetch = deps.fetchImpl ?? fetch;
  const resolve = deps.resolveHost ?? defaultResolve;
  const rows = (await ctx.db.query(
    `SELECT d.id, d.endpoint_id, d.event, d.payload, d.attempts, e.url, e.secret_enc
     FROM webhook_delivery d JOIN webhook_endpoint e ON e.id = d.endpoint_id
     WHERE d.status='PENDING' AND d.next_attempt_at <= $1 AND e.active ORDER BY d.next_attempt_at LIMIT $2 FOR UPDATE OF d SKIP LOCKED`, [now, limit])).rows;
  for (const d of rows) {
    let status: number | null = null;
    let error: string | null = null;
    try {
      const url = new URL(d.url);
      if (!deps.allowInsecure) {
        const ips = await resolve(url.hostname.replace(/^\[|\]$/g, ''));
        if (ips.length === 0 || ips.some(isPrivateAddress)) throw new Error('Địa chỉ đích phân giải ra IP nội bộ, đã chặn.');
      }
      const body = JSON.stringify(d.payload);
      const ts = Math.floor(now.getTime() / 1000);
      const secret = decryptSecret(d.secret_enc, need(ctx.keyRing, 'MASTER_KEY'));
      const res = await doFetch(d.url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
        headers: {
          'content-type': 'application/json', 'user-agent': 'RentPro-Webhook/1.0', 'x-rentpro-event': d.event, 'x-rentpro-delivery': d.id,
          'x-rentpro-timestamp': String(ts), 'x-rentpro-signature': signWebhook(secret, ts, body),
        },
        body,
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = res.status >= 300 && res.status < 400 ? `Đích trả chuyển hướng ${res.status} (không theo)` : `Đích trả lỗi ${res.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 300) : String(e);
    }
    const attempts = d.attempts + 1;
    if (!error) {
      await ctx.db.query("UPDATE webhook_delivery SET status='SENT', attempts=$2, last_status=$3, last_error=NULL, sent_at=$4 WHERE id=$1", [d.id, attempts, status, now]);
      await ctx.db.query('UPDATE webhook_endpoint SET consecutive_failures=0 WHERE id=$1 AND consecutive_failures<>0', [d.endpoint_id]);
      out.sent++;
      continue;
    }
    const delay = attempts < MAX_ATTEMPTS ? retryDelay(attempts) : null;
    if (delay !== null) {
      await ctx.db.query('UPDATE webhook_delivery SET attempts=$2, last_status=$3, last_error=$4, next_attempt_at=$5 WHERE id=$1', [d.id, attempts, status, error, new Date(now.getTime() + delay * 1000)]);
      out.retried++;
    } else {
      await ctx.db.query("UPDATE webhook_delivery SET status='FAILED', attempts=$2, last_status=$3, last_error=$4 WHERE id=$1", [d.id, attempts, status, error]);
      out.failed++;
    }
    const ep = (await ctx.db.query('UPDATE webhook_endpoint SET consecutive_failures = consecutive_failures + 1 WHERE id=$1 RETURNING consecutive_failures', [d.endpoint_id])).rows[0];
    if (ep && ep.consecutive_failures >= ENDPOINT_AUTO_DISABLE_AFTER) {
      await ctx.db.query("UPDATE webhook_endpoint SET active=false, disabled_reason=$2 WHERE id=$1 AND active", [d.endpoint_id, `Tự tắt sau ${ENDPOINT_AUTO_DISABLE_AFTER} lần lỗi liên tiếp`]);
      out.disabled++;
    }
  }
  return out;
}

