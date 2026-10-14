import {
  CHANNELS, DEFAULT_QUIET, DEFAULT_REMINDERS, DEFAULT_TEMPLATES, NOTIFY_EVENT_LABEL, NOTIFY_SETTINGS_VERSION, NotifySettingsSchema, dueReminders, firstZodMessage,
  quietWindowEnd, renderTemplate, upgradeNotifySettings, zonedTimeToUtc, type Channel, type NotifyEvent, type NotifySettings, type QuietHours, type ReminderConfig,
} from '@rentpro/core';
import { buildProvider, isEmail, normalizeVnPhone, type NotificationProvider, type ProviderConfig } from '@rentpro/notifications';
import { can, decryptSecret, encryptSecret, type FeatureKey } from '@rentpro/tenancy';
import { computeLedger, rawFinanceSettings } from './finance';
import { NotFoundError, ValidationError, audit, guard, type ServiceCtx } from './service';

type Row = Record<string, any>;

/** Phụ thuộc bên ngoài của việc gửi tin: tài khoản chung của nền tảng và cách dựng nhà cung cấp (thay được khi test). */
export interface NotifyDeps {
  shared?: Partial<Record<Channel, ProviderConfig>>;
  build?: (c: ProviderConfig) => NotificationProvider;
}

const FEATURE_OF: Record<Channel, FeatureKey> = { email: 'notify.email', sms: 'notify.sms', zalo: 'notify.zalo' };
const MAX_ATTEMPTS = 3;

// ===== Cấu hình =====
export async function rawNotifySettings(ctx: ServiceCtx): Promise<NotifySettings> {
  const r = (await ctx.db.query('SELECT settings FROM tenant WHERE id=$1', [ctx.tenantId])).rows[0];
  return upgradeNotifySettings(r?.settings?.notify);
}

/** Cấu hình hiển thị cho người dùng: không bao giờ trả khóa/mật khẩu, chỉ cho biết đã cài hay chưa. */
export interface NotifySettingsView {
  channels: Channel[]; quietHours: QuietHours; reminders: ReminderConfig; templates: Record<NotifyEvent, string>; customTemplates: NotifyEvent[];
  email: { mode: string; host: string; port: number; secure: boolean; user: string; from: string; hasPassword: boolean };
  sms: { mode: string; brandname: string; hasApiKey: boolean; hasSecret: boolean };
  zalo: { mode: string; oaId: string; templateId: string; hasToken: boolean };
}

export async function getNotifySettings(ctx: ServiceCtx): Promise<NotifySettingsView> {
  guard(ctx, 'settings.manage', 'notify.email');
  const s = await rawNotifySettings(ctx);
  const p = s.providers ?? {};
  const t = (s.templates ?? {}) as Partial<Record<NotifyEvent, string>>;
  return {
    channels: s.channels, quietHours: s.quietHours ?? DEFAULT_QUIET, reminders: s.reminders ?? DEFAULT_REMINDERS,
    templates: { ...DEFAULT_TEMPLATES, ...t }, customTemplates: Object.keys(t) as NotifyEvent[],
    email: { mode: p.email?.mode ?? 'console', host: p.email?.host ?? '', port: p.email?.port ?? 587, secure: p.email?.secure ?? false, user: p.email?.user ?? '', from: p.email?.from ?? '', hasPassword: !!p.email?.passSealed },
    sms: { mode: p.sms?.mode ?? 'console', brandname: p.sms?.brandname ?? '', hasApiKey: !!p.sms?.apiKeySealed, hasSecret: !!p.sms?.secretSealed },
    zalo: { mode: p.zalo?.mode ?? 'console', oaId: p.zalo?.oaId ?? '', templateId: p.zalo?.templateId ?? '', hasToken: !!p.zalo?.accessTokenSealed },
  };
}

export interface NotifySettingsInput {
  channels: Channel[]; quietHours: QuietHours; reminders: ReminderConfig;
  /** Mẫu trống hoặc trùng mặc định = dùng mẫu mặc định */
  templates: Partial<Record<NotifyEvent, string>>;
  email: { mode: 'console' | 'smtp' | 'shared'; host?: string; port?: number; secure?: boolean; user?: string; from?: string; password?: string };
  sms: { mode: 'console' | 'esms' | 'speedsms' | 'shared'; brandname?: string; apiKey?: string; secret?: string };
  zalo: { mode: 'console' | 'zns' | 'shared'; oaId?: string; templateId?: string; accessToken?: string };
}

export async function updateNotifySettings(ctx: ServiceCtx, i: NotifySettingsInput): Promise<void> {
  guard(ctx, 'settings.manage', 'notify.email', { write: true });
  const cur = (await rawNotifySettings(ctx)).providers ?? {};
  const ring = ctx.keyRing;
  const seal = (plain: string | undefined, old: string | undefined) => {
    if (!plain?.trim()) return old;
    if (!ring) throw new ValidationError('Máy chủ chưa cấu hình khóa mã hóa (MASTER_KEY) nên không lưu được khóa/mật khẩu.');
    return encryptSecret(plain.trim(), ring);
  };
  for (const ch of i.channels) if (!can(ctx.features, FEATURE_OF[ch])) throw new ValidationError(`Gói hiện tại không có kênh ${ch === 'zalo' ? 'Zalo' : ch === 'sms' ? 'SMS' : 'Email'}. Hãy nâng cấp gói.`);
  if (i.sms.mode !== 'console' && !can(ctx.features, 'notify.sms')) throw new ValidationError('Gói hiện tại không có SMS. Hãy nâng cấp gói.');
  if (i.zalo.mode !== 'console' && !can(ctx.features, 'notify.zalo')) throw new ValidationError('Gói hiện tại không có Zalo. Hãy nâng cấp gói.');

  const email = { mode: i.email.mode, host: i.email.host?.trim() || undefined, port: i.email.port, secure: i.email.secure ?? false, user: i.email.user?.trim() || undefined, from: i.email.from?.trim() || undefined, passSealed: seal(i.email.password, cur.email?.passSealed) };
  const sms = { mode: i.sms.mode, brandname: i.sms.brandname?.trim() || undefined, apiKeySealed: seal(i.sms.apiKey, cur.sms?.apiKeySealed), secretSealed: seal(i.sms.secret, cur.sms?.secretSealed) };
  const zalo = { mode: i.zalo.mode, oaId: i.zalo.oaId?.trim() || undefined, templateId: i.zalo.templateId?.trim() || undefined, accessTokenSealed: seal(i.zalo.accessToken, cur.zalo?.accessTokenSealed) };
  if (email.mode === 'smtp' && (!email.host || !email.port || !email.from)) throw new ValidationError('SMTP cần máy chủ, cổng và địa chỉ gửi.');
  if (email.mode === 'smtp' && email.from && !isEmail(email.from)) throw new ValidationError('Địa chỉ gửi email không hợp lệ.');
  if (sms.mode === 'esms' && (!sms.apiKeySealed || !sms.secretSealed)) throw new ValidationError('eSMS cần ApiKey và SecretKey.');
  if (sms.mode === 'speedsms' && !sms.apiKeySealed) throw new ValidationError('SpeedSMS cần Access Token.');
  if (zalo.mode === 'zns' && (!zalo.accessTokenSealed || !zalo.templateId)) throw new ValidationError('Zalo ZNS cần Access Token và mã mẫu tin (template).');

  const templates: Record<string, string> = {};
  for (const [e, body] of Object.entries(i.templates)) if (body?.trim() && body.trim() !== DEFAULT_TEMPLATES[e as NotifyEvent]) templates[e] = body.trim();
  const p = NotifySettingsSchema.safeParse({
    v: NOTIFY_SETTINGS_VERSION, channels: [...new Set(i.channels)], quietHours: i.quietHours, reminders: i.reminders, templates, providers: { email, sms, zalo },
  });
  if (!p.success) throw new ValidationError(firstZodMessage(p.error));
  const clean = JSON.parse(JSON.stringify(p.data));
  await ctx.db.query(`UPDATE tenant SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{notify}', $2::jsonb, true) WHERE id=$1`, [ctx.tenantId, JSON.stringify(clean)]);
  await audit(ctx, 'settings.notify', 'tenant', ctx.tenantId, { channels: clean.channels, modes: { email: email.mode, sms: sms.mode, zalo: zalo.mode } });
}

// ===== Chọn nhà cung cấp =====
interface Resolved { provider: NotificationProvider; scope: 'OWN' | 'SHARED' | 'CONSOLE' }

function resolveProvider(ctx: ServiceCtx, s: NotifySettings, ch: Channel, deps: NotifyDeps): Resolved {
  const build = deps.build ?? ((c: ProviderConfig) => buildProvider(c));
  const p = s.providers ?? {};
  const open = (sealed: string | undefined) => {
    if (!sealed) return '';
    if (!ctx.keyRing) throw new ValidationError('Thiếu khóa mã hóa để đọc cấu hình nhà cung cấp.');
    return decryptSecret(sealed, ctx.keyRing);
  };
  const mode = p[ch]?.mode ?? 'console';
  if (mode === 'console') return { provider: build({ channel: ch, mode: 'console' } as ProviderConfig), scope: 'CONSOLE' };
  if (mode === 'shared') {
    const sh = deps.shared?.[ch];
    if (!sh) throw new ValidationError('Nền tảng chưa cấu hình tài khoản gửi chung cho kênh này.');
    return { provider: build(sh), scope: 'SHARED' };
  }
  if (ch === 'email') {
    const e = p.email!;
    return { provider: build({ channel: 'email', mode: 'smtp', smtp: { host: e.host!, port: e.port!, secure: e.secure ?? false, user: e.user, pass: open(e.passSealed) || undefined, from: e.from! } }), scope: 'OWN' };
  }
  if (ch === 'sms') {
    const m = p.sms!;
    return { provider: build(m.mode === 'esms' ? { channel: 'sms', mode: 'esms', apiKey: open(m.apiKeySealed), secretKey: open(m.secretSealed), brandname: m.brandname } : { channel: 'sms', mode: 'speedsms', accessToken: open(m.apiKeySealed), sender: m.brandname }), scope: 'OWN' };
  }
  const z = p.zalo!;
  return { provider: build({ channel: 'zalo', mode: 'zns', accessToken: open(z.accessTokenSealed), templateId: z.templateId! }), scope: 'OWN' };
}

// ===== Hàng đợi =====
interface QueueInput {
  event: string; channel: Channel; recipient: string; body: string; subject?: string | null; key: string;
  bookingId?: string | null; customerId?: string | null; scheduledFor?: Date; status?: 'QUEUED' | 'SKIPPED'; error?: string | null;
}

async function enqueue(ctx: ServiceCtx, q: QueueInput): Promise<string | null> {
  const r = await ctx.db.query(
    `INSERT INTO notification_log(tenant_id,booking_id,customer_id,event,channel,recipient,subject,body,status,error,idempotency_key,scheduled_for,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
    [ctx.tenantId, q.bookingId ?? null, q.customerId ?? null, q.event, q.channel, q.recipient, q.subject ?? null, q.body, q.status ?? 'QUEUED', q.error ?? null, q.key, q.scheduledFor ?? new Date(), ctx.userId]);
  return r.rows[0]?.id ?? null;
}

export async function pushInbox(ctx: ServiceCtx, i: { kind: string; title: string; body?: string; link?: string; permission?: string | null; dedupeKey: string }): Promise<boolean> {
  const r = await ctx.db.query(
    `INSERT INTO app_notification(tenant_id,kind,title,body,link,permission,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, dedupe_key) DO NOTHING RETURNING id`,
    [ctx.tenantId, i.kind, i.title, i.body ?? null, i.link ?? null, i.permission ?? null, i.dedupeKey]);
  return r.rows.length > 0;
}

function pickChannel(ctx: ServiceCtx, s: NotifySettings, c: { phone: string | null; email: string | null }): { channel: Channel; to: string } | null {
  for (const ch of s.channels) {
    if (!can(ctx.features, FEATURE_OF[ch])) continue;
    if (ch === 'email' && c.email && isEmail(c.email)) return { channel: ch, to: c.email };
    if (ch !== 'email' && c.phone && normalizeVnPhone(c.phone)) return { channel: ch, to: c.phone };
  }
  return null;
}

const vnd = (n: number) => `${new Intl.NumberFormat('vi-VN').format(n)} đ`;
const when = (d: Date, tz: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);

export interface ScanEnv {
  /** Liên kết thanh toán công khai cho khách; không có thì biến {link_thanh_toan} để trống */
  payLink?: (bookingId: string) => string | null;
}
export interface ScanResult { queued: number; skipped: number; alerts: number }

/** Quét đơn thuê, tạo tin nhắc đến hạn (idempotent theo sự kiện + đơn + slot) và cảnh báo trong app cho quản lý. */
export async function scanReminders(ctx: ServiceCtx, now: Date, env: ScanEnv = {}): Promise<ScanResult> {
  guard(ctx, 'settings.manage', 'notify.email', { write: true });
  const s = await rawNotifySettings(ctx);
  const cfg = s.reminders ?? DEFAULT_REMINDERS;
  const tz = ctx.timezone ?? 'Asia/Ho_Chi_Minh';
  const shop = (await rawFinanceSettings(ctx)).store?.name ?? (await ctx.db.query('SELECT name FROM tenant WHERE id=$1', [ctx.tenantId])).rows[0]?.name ?? '';
  const rows = (await ctx.db.query(
    `SELECT b.id, b.code, b.status, b.starts_at, b.ends_at, b.hold_expires_at, b.returned_at, c.id AS customer_id, c.name AS customer_name, c.phone, c.email,
       (SELECT string_agg(m.name || CASE WHEN l.qty > 1 THEN ' x' || l.qty ELSE '' END, ', ' ORDER BY m.name) FROM booking_line l JOIN equipment_model m ON m.id = l.model_id WHERE l.booking_id = b.id) AS items
     FROM booking b JOIN customer c ON c.id = b.customer_id
     WHERE b.deleted_at IS NULL AND (b.status = 'ACTIVE' OR (b.status = 'HOLD' AND b.hold_expires_at IS NOT NULL)
        OR (b.status = 'RETURNED' AND b.returned_at > $1))
     ORDER BY b.ends_at LIMIT 500`, [new Date(now.getTime() - 90 * 86_400_000)])).rows;
  const out: ScanResult = { queued: 0, skipped: 0, alerts: 0 };
  for (const b of rows) {
    const balance = b.status === 'RETURNED' ? (await computeLedger(ctx, b.id)).settlement.balanceOwed : 0;
    const due = dueReminders({ status: b.status, startsAt: b.starts_at, endsAt: b.ends_at, holdExpiresAt: b.hold_expires_at, returnedAt: b.returned_at, balanceOwed: balance }, now, cfg);
    for (const d of due) {
      const key = `${d.event}:${b.id}:${d.slot}`;
      const deadline: Date = d.event === 'HOLD_EXPIRING' ? b.hold_expires_at : b.ends_at;
      if (d.event === 'OVERDUE' || d.event === 'DEBT') {
        const fresh = await pushInbox(ctx, {
          kind: d.event, title: d.event === 'OVERDUE' ? `Đơn ${b.code} quá hạn trả` : `Đơn ${b.code} còn công nợ ${vnd(balance)}`,
          body: `${b.customer_name} · ${b.phone}`, link: `/bookings/${b.id}`, permission: 'users.manage', dedupeKey: `alert:${key}`,
        });
        if (fresh) out.alerts++;
      }
      const link = env.payLink?.(b.id) ?? '';
      let body: string;
      try {
        body = renderTemplate((s.templates as Partial<Record<NotifyEvent, string>> | undefined)?.[d.event] ?? DEFAULT_TEMPLATES[d.event], {
          ten_khach: b.customer_name, ma_don: b.code, thiet_bi: b.items ?? '', han_tra: when(deadline, tz), so_tien: balance > 0 ? vnd(balance) : '',
          link_thanh_toan: link, ten_cua_hang: shop,
        });
      } catch (e) {
        throw new ValidationError(`Mẫu tin "${NOTIFY_EVENT_LABEL[d.event]}" không hợp lệ: ${(e as Error).message}`);
      }
      const pick = pickChannel(ctx, s, { phone: b.phone, email: b.email });
      const base = { event: d.event, key, bookingId: b.id, customerId: b.customer_id, body, subject: `${NOTIFY_EVENT_LABEL[d.event]} – đơn ${b.code}` };
      if (!pick) {
        const ok = await enqueue(ctx, { ...base, channel: s.channels[0] ?? 'sms', recipient: '-', status: 'SKIPPED', error: 'Khách chưa có số điện thoại/email phù hợp với kênh đã bật.' });
        if (ok) out.skipped++;
        continue;
      }
      if (await enqueue(ctx, { ...base, channel: pick.channel, recipient: pick.to })) out.queued++;
    }
  }
  return out;
}

// ===== Gửi =====
export interface DispatchResult { sent: number; failed: number; retried: number; skipped: number; deferred: number }

const monthKey = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(d); // 2027-03

async function sharedUsage(ctx: ServiceCtx, now: Date): Promise<number> {
  const tz = ctx.timezone ?? 'Asia/Ho_Chi_Minh';
  const start = zonedTimeToUtc(`${monthKey(now, tz)}-01T00:00`, tz)!;
  return (await ctx.db.query(`SELECT count(*)::int n FROM notification_log WHERE status='SENT' AND scope='SHARED' AND sent_at >= $1`, [start])).rows[0].n;
}

/** Gửi các tin đến hạn: tôn trọng giờ nghỉ, hạn mức tài khoản chung, thử lại có giãn cách, không bao giờ ném lỗi vì một tin hỏng. */
export async function dispatchQueued(ctx: ServiceCtx, now: Date, deps: NotifyDeps = {}, limit = 25): Promise<DispatchResult> {
  guard(ctx, 'settings.manage', 'notify.email', { write: true });
  const s = await rawNotifySettings(ctx);
  const tz = ctx.timezone ?? 'Asia/Ho_Chi_Minh';
  const quiet = s.quietHours ?? DEFAULT_QUIET;
  const out: DispatchResult = { sent: 0, failed: 0, retried: 0, skipped: 0, deferred: 0 };
  const rows = (await ctx.db.query(`SELECT * FROM notification_log WHERE status='QUEUED' AND scheduled_for <= $1 ORDER BY scheduled_for, created_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit])).rows;
  let usage: number | null = null;
  const cache = new Map<Channel, Resolved | string>();
  for (const r of rows) {
    const ch = r.channel as Channel;
    // Tin TEST do người dùng chủ động bấm gửi nên không bị giờ nghỉ chặn
    const hold = r.event === 'TEST' ? null : quietWindowEnd(now, tz, quiet);
    if (hold) {
      await ctx.db.query('UPDATE notification_log SET scheduled_for=$2, updated_at=now() WHERE id=$1', [r.id, hold]);
      out.deferred++;
      continue;
    }
    if (!can(ctx.features, FEATURE_OF[ch])) {
      await ctx.db.query(`UPDATE notification_log SET status='SKIPPED', error=$2, updated_at=now() WHERE id=$1`, [r.id, 'Gói hiện tại không có kênh này.']);
      out.skipped++;
      continue;
    }
    if (!cache.has(ch)) {
      try { cache.set(ch, resolveProvider(ctx, s, ch, deps)); } catch (e) { cache.set(ch, (e as Error).message); }
    }
    const res = cache.get(ch)!;
    if (typeof res === 'string') {
      await ctx.db.query(`UPDATE notification_log SET status='FAILED', attempts=attempts+1, error=$2, updated_at=now() WHERE id=$1`, [r.id, res]);
      out.failed++;
      continue;
    }
    if (res.scope === 'SHARED') {
      usage ??= await sharedUsage(ctx, now);
      const max = ctx.limits.messages_per_month;
      if (max !== null && usage >= max) {
        await ctx.db.query(`UPDATE notification_log SET status='SKIPPED', error=$2, updated_at=now() WHERE id=$1`, [r.id, `Đã dùng hết hạn mức ${max} tin/tháng của gói. Hãy dùng tài khoản gửi riêng hoặc nâng cấp gói.`]);
        await pushInbox(ctx, { kind: 'QUOTA', title: 'Hết hạn mức tin nhắn tháng này', body: 'Các tin nhắc tiếp theo bị bỏ qua cho đến khi sang tháng hoặc nâng cấp gói.', link: '/notifications', permission: 'settings.manage', dedupeKey: `quota100:${monthKey(now, tz)}` });
        out.skipped++;
        continue;
      }
    }
    const r2 = await res.provider.send({ channel: ch, to: r.recipient, body: r.body, subject: r.subject ?? undefined, idempotencyKey: r.idempotency_key });
    if (r2.ok) {
      await ctx.db.query(`UPDATE notification_log SET status='SENT', attempts=attempts+1, error=NULL, provider=$2, provider_id=$3, scope=$4, sent_at=$5, updated_at=now() WHERE id=$1`, [r.id, res.provider.name, r2.providerId ?? null, res.scope, now]);
      out.sent++;
      if (res.scope === 'SHARED') {
        usage = (usage ?? 0) + 1;
        const max = ctx.limits.messages_per_month;
        if (max !== null && max > 0 && usage / max >= 0.8) {
          await pushInbox(ctx, { kind: 'QUOTA', title: `Đã dùng ${usage}/${max} tin nhắn trong tháng`, body: 'Sắp hết hạn mức tin nhắn của gói.', link: '/notifications', permission: 'settings.manage', dedupeKey: `quota80:${monthKey(now, tz)}` });
        }
      }
    } else if (r2.retryable && r.attempts + 1 < MAX_ATTEMPTS) {
      const wait = 5 * 4 ** r.attempts; // 5, 20 phút
      await ctx.db.query(`UPDATE notification_log SET attempts=attempts+1, error=$2, provider=$3, scheduled_for=$4, updated_at=now() WHERE id=$1`, [r.id, r2.error, res.provider.name, new Date(now.getTime() + wait * 60_000)]);
      out.retried++;
    } else {
      await ctx.db.query(`UPDATE notification_log SET status='FAILED', attempts=attempts+1, error=$2, provider=$3, updated_at=now() WHERE id=$1`, [r.id, r2.error, res.provider.name]);
      out.failed++;
    }
  }
  return out;
}

// ===== Thao tác của người dùng =====
export interface NotificationRow {
  id: string; bookingId: string | null; bookingCode: string | null; customerName: string | null; event: string; eventLabel: string; channel: Channel; recipient: string;
  body: string; status: string; error: string | null; attempts: number; provider: string | null; scope: string; scheduledFor: Date; sentAt: Date | null; createdAt: Date;
}

export async function listNotifications(ctx: ServiceCtx, f: { status?: string; bookingId?: string; limit?: number; offset?: number } = {}): Promise<NotificationRow[]> {
  guard(ctx, 'notification.view', 'notify.email');
  const rows = (await ctx.db.query(
    `SELECT n.*, b.code AS booking_code, c.name AS customer_name FROM notification_log n LEFT JOIN booking b ON b.id=n.booking_id LEFT JOIN customer c ON c.id=n.customer_id
     WHERE ($1::text IS NULL OR n.status=$1) AND ($2::uuid IS NULL OR n.booking_id=$2) ORDER BY n.created_at DESC LIMIT $3 OFFSET $4`,
    [f.status ?? null, f.bookingId ?? null, Math.min(f.limit ?? 50, 200), f.offset ?? 0])).rows;
  return rows.map((r: Row) => ({
    id: r.id, bookingId: r.booking_id, bookingCode: r.booking_code, customerName: r.customer_name, event: r.event,
    eventLabel: r.event === 'TEST' ? 'Gửi thử' : NOTIFY_EVENT_LABEL[r.event as NotifyEvent] ?? r.event, channel: r.channel, recipient: r.recipient, body: r.body, status: r.status,
    error: r.error, attempts: r.attempts, provider: r.provider, scope: r.scope, scheduledFor: r.scheduled_for, sentAt: r.sent_at, createdAt: r.created_at,
  }));
}

/** Gửi lại một tin thất bại hoặc bị bỏ qua (tin đã gửi thành công thì không gửi lại để khỏi làm phiền khách). */
export async function resendNotification(ctx: ServiceCtx, id: string): Promise<void> {
  guard(ctx, 'notification.manage', 'notify.email', { write: true });
  const n = (await ctx.db.query('SELECT status, recipient FROM notification_log WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!n) throw new NotFoundError('tin nhắn');
  if (n.status === 'SENT') throw new ValidationError('Tin này đã gửi thành công, không cần gửi lại.');
  if (n.status === 'QUEUED') throw new ValidationError('Tin này đang chờ gửi.');
  if (n.recipient === '-') throw new ValidationError('Tin này chưa có người nhận. Hãy bổ sung số điện thoại/email của khách rồi để hệ thống tự tạo lại ở lần quét sau, hoặc gửi thử thủ công.');
  await ctx.db.query(`UPDATE notification_log SET status='QUEUED', attempts=0, error=NULL, scheduled_for=now(), updated_at=now() WHERE id=$1`, [id]);
  await audit(ctx, 'notification.resend', 'notification', id);
}

/** Gửi thử ngay một tin để kiểm tra cấu hình kênh. Trả kết quả để hiện cho người dùng. */
export async function sendTestNotification(ctx: ServiceCtx, channel: Channel, to: string, deps: NotifyDeps = {}): Promise<{ ok: boolean; message: string }> {
  guard(ctx, 'notification.manage', FEATURE_OF[channel], { write: true });
  const dest = to.trim();
  if (channel === 'email' ? !isEmail(dest) : !normalizeVnPhone(dest)) throw new ValidationError(channel === 'email' ? 'Địa chỉ email không hợp lệ.' : 'Số điện thoại không hợp lệ.');
  const s = await rawNotifySettings(ctx);
  const res = resolveProvider(ctx, s, channel, deps);
  const key = `TEST:${crypto.randomUUID()}`;
  const id = await enqueue(ctx, { event: 'TEST', channel, recipient: dest, body: 'Tin nhắn thử từ RentPro. Nếu bạn nhận được tin này, cấu hình gửi tin đã hoạt động.', subject: 'Tin nhắn thử', key });
  const r = await res.provider.send({ channel, to: dest, body: 'Tin nhắn thử từ RentPro. Nếu bạn nhận được tin này, cấu hình gửi tin đã hoạt động.', subject: 'Tin nhắn thử', idempotencyKey: key });
  if (r.ok) await ctx.db.query(`UPDATE notification_log SET status='SENT', attempts=1, provider=$2, provider_id=$3, scope=$4, sent_at=now(), updated_at=now() WHERE id=$1`, [id, res.provider.name, r.providerId ?? null, res.scope]);
  else await ctx.db.query(`UPDATE notification_log SET status='FAILED', attempts=1, error=$2, provider=$3, updated_at=now() WHERE id=$1`, [id, r.error, res.provider.name]);
  return r.ok ? { ok: true, message: res.scope === 'CONSOLE' ? 'Đã ghi nhận (chế độ giả lập, chưa gửi thật).' : 'Đã gửi tin thử.' } : { ok: false, message: r.error };
}

// ===== Hộp thư trong app =====
export interface InboxItem { id: string; kind: string; title: string; body: string | null; link: string | null; createdAt: Date; read: boolean }

export async function listInbox(ctx: ServiceCtx, limit = 30): Promise<{ items: InboxItem[]; unread: number }> {
  const perms = [...ctx.permissions];
  const rows = (await ctx.db.query(
    `SELECT id, kind, title, body, link, created_at, ($2::uuid IS NOT NULL AND $2::uuid = ANY(read_by)) AS read FROM app_notification
     WHERE permission IS NULL OR permission = ANY($1::text[]) ORDER BY created_at DESC LIMIT $3`, [perms, ctx.userId, Math.min(limit, 100)])).rows;
  return { items: rows.map((r: Row) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.created_at, read: r.read })), unread: rows.filter((r: Row) => !r.read).length };
}

export async function markInboxRead(ctx: ServiceCtx, id?: string): Promise<void> {
  if (!ctx.userId) return;
  const perms = [...ctx.permissions];
  await ctx.db.query(
    `UPDATE app_notification SET read_by = array_append(read_by, $1::uuid) WHERE NOT ($1::uuid = ANY(read_by)) AND ($2::uuid IS NULL OR id = $2)
     AND (permission IS NULL OR permission = ANY($3::text[]))`, [ctx.userId, id ?? null, perms]);
}

export { CHANNELS };
