import nodemailer from 'nodemailer';

export type Channel = 'zalo' | 'sms' | 'email';

export interface OutgoingMessage {
  channel: Channel;
  /** Số điện thoại (sms/zalo) hoặc địa chỉ email */
  to: string;
  body: string;
  subject?: string;
  /** Khóa chống gửi trùng: nhà cung cấp hỗ trợ thì dùng làm mã theo dõi */
  idempotencyKey: string;
}

export type SendResult = { ok: true; providerId?: string } | { ok: false; error: string; retryable: boolean };

/** Mọi kênh gửi (Zalo ZNS, SMS, Email, Console) cài đặt giao diện này. Không ném lỗi: trả SendResult. */
export interface NotificationProvider {
  readonly channel: Channel;
  readonly name: string;
  send(m: OutgoingMessage): Promise<SendResult>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** Số điện thoại Việt Nam về dạng quốc tế không dấu cộng: 0901234567 → 84901234567. null nếu không hợp lệ. */
export function normalizeVnPhone(raw: string): string | null {
  const d = raw.replace(/[\s.\-()]/g, '');
  if (/^\+?84\d{9}$/.test(d)) return d.replace(/^\+/, '');
  if (/^0\d{9}$/.test(d)) return `84${d.slice(1)}`;
  return null;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

const bad = (error: string, retryable = false): SendResult => ({ ok: false, error, retryable });
const failHttp = (status: number, text: string): SendResult => bad(`Nhà cung cấp trả lỗi ${status}: ${text.slice(0, 200)}`, status >= 500 || status === 429);
const netErr = (e: unknown): SendResult => bad(`Lỗi kết nối: ${e instanceof Error ? e.message : String(e)}`, true);

/** Giả lập: không gửi đi đâu, chỉ ghi lại. Dùng khi thử nghiệm hoặc chưa cấu hình nhà cung cấp. */
export class ConsoleProvider implements NotificationProvider {
  readonly name = 'console';
  readonly sent: OutgoingMessage[] = [];
  constructor(readonly channel: Channel) {}
  async send(m: OutgoingMessage): Promise<SendResult> {
    this.sent.push(m);
    return { ok: true, providerId: `console:${m.idempotencyKey}` };
  }
}

export interface SmtpConfig { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }
export interface MailTransport { sendMail(o: { from: string; to: string; subject: string; text: string; headers?: Record<string, string> }): Promise<{ messageId?: string }> }

export class SmtpProvider implements NotificationProvider {
  readonly channel = 'email' as const;
  readonly name = 'smtp';
  private readonly transport: MailTransport;
  constructor(private readonly cfg: SmtpConfig, transport?: MailTransport) {
    this.transport = transport ?? nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined, connectionTimeout: 10_000, socketTimeout: 15_000 });
  }
  async send(m: OutgoingMessage): Promise<SendResult> {
    if (!isEmail(m.to)) return bad('Địa chỉ email không hợp lệ.');
    try {
      const r = await this.transport.sendMail({ from: this.cfg.from, to: m.to, subject: m.subject ?? 'Thông báo từ cửa hàng', text: m.body, headers: { 'X-Idempotency-Key': m.idempotencyKey } });
      return { ok: true, providerId: r.messageId };
    } catch (e) {
      const code = (e as { responseCode?: number }).responseCode;
      return code && code >= 500 && code < 600 && code !== 503 ? bad(`SMTP từ chối: ${(e as Error).message}`) : netErr(e);
    }
  }
}

export class EsmsProvider implements NotificationProvider {
  readonly channel = 'sms' as const;
  readonly name = 'esms';
  constructor(private readonly cfg: { apiKey: string; secretKey: string; brandname?: string }, private readonly fetchImpl: FetchLike = defaultFetch) {}
  async send(m: OutgoingMessage): Promise<SendResult> {
    const phone = normalizeVnPhone(m.to);
    if (!phone) return bad('Số điện thoại không hợp lệ.');
    try {
      const r = await this.fetchImpl('https://rest.esms.vn/MainService.svc/json/SendMultipleMessage_V4_post_json/', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ApiKey: this.cfg.apiKey, SecretKey: this.cfg.secretKey, Phone: phone, Content: m.body, SmsType: this.cfg.brandname ? '2' : '8', Brandname: this.cfg.brandname ?? '', RequestId: m.idempotencyKey.slice(0, 60), IsUnicode: '1' }),
      });
      const text = await r.text();
      if (!r.ok) return failHttp(r.status, text);
      const j = safeJson(text);
      return String(j?.CodeResult) === '100' ? { ok: true, providerId: String(j?.SMSID ?? '') } : bad(`eSMS báo lỗi ${String(j?.CodeResult ?? '?')}: ${String(j?.ErrorMessage ?? text.slice(0, 120))}`);
    } catch (e) {
      return netErr(e);
    }
  }
}

export class SpeedSmsProvider implements NotificationProvider {
  readonly channel = 'sms' as const;
  readonly name = 'speedsms';
  constructor(private readonly cfg: { accessToken: string; sender?: string }, private readonly fetchImpl: FetchLike = defaultFetch) {}
  async send(m: OutgoingMessage): Promise<SendResult> {
    const phone = normalizeVnPhone(m.to);
    if (!phone) return bad('Số điện thoại không hợp lệ.');
    try {
      const r = await this.fetchImpl('https://api.speedsms.vn/index.php/sms/send', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${this.cfg.accessToken}:x`).toString('base64')}` },
        body: JSON.stringify({ to: [phone], content: m.body, sms_type: this.cfg.sender ? 3 : 2, sender: this.cfg.sender ?? '' }),
      });
      const text = await r.text();
      if (!r.ok) return failHttp(r.status, text);
      const j = safeJson(text);
      return j?.status === 'success' ? { ok: true, providerId: String(((j?.data as { tranId?: unknown } | undefined)?.tranId) ?? '') } : bad(`SpeedSMS báo lỗi: ${String(j?.message ?? text.slice(0, 120))}`);
    } catch (e) {
      return netErr(e);
    }
  }
}

/** Zalo ZNS: gửi theo mẫu (template) đã được Zalo duyệt; nội dung truyền vào tham số `noi_dung` của mẫu. */
export class ZaloZnsProvider implements NotificationProvider {
  readonly channel = 'zalo' as const;
  readonly name = 'zalo-zns';
  constructor(private readonly cfg: { accessToken: string; templateId: string }, private readonly fetchImpl: FetchLike = defaultFetch) {}
  async send(m: OutgoingMessage): Promise<SendResult> {
    const phone = normalizeVnPhone(m.to);
    if (!phone) return bad('Số điện thoại không hợp lệ.');
    try {
      const r = await this.fetchImpl('https://business.openapi.zalo.me/message/template', {
        method: 'POST', headers: { 'content-type': 'application/json', access_token: this.cfg.accessToken },
        body: JSON.stringify({ phone, template_id: this.cfg.templateId, template_data: { noi_dung: m.body }, tracking_id: m.idempotencyKey.slice(0, 48) }),
      });
      const text = await r.text();
      if (!r.ok) return failHttp(r.status, text);
      const j = safeJson(text);
      return j?.error === 0 ? { ok: true, providerId: String(((j?.data as { msg_id?: unknown } | undefined)?.msg_id) ?? '') } : bad(`Zalo báo lỗi ${String(j?.error ?? '?')}: ${String(j?.message ?? '')}`);
    } catch (e) {
      return netErr(e);
    }
  }
}

function safeJson(t: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Cấu hình đã GIẢI MÃ của một kênh (chỉ tồn tại trong bộ nhớ lúc gửi). */
export type ProviderConfig =
  | { channel: 'email'; mode: 'console' }
  | { channel: 'email'; mode: 'smtp'; smtp: SmtpConfig }
  | { channel: 'sms'; mode: 'console' }
  | { channel: 'sms'; mode: 'esms'; apiKey: string; secretKey: string; brandname?: string }
  | { channel: 'sms'; mode: 'speedsms'; accessToken: string; sender?: string }
  | { channel: 'zalo'; mode: 'console' }
  | { channel: 'zalo'; mode: 'zns'; accessToken: string; templateId: string };

export interface ProviderDeps { fetchImpl?: FetchLike; mailTransport?: MailTransport; consoleProviders?: Map<Channel, ConsoleProvider> }

export function buildProvider(c: ProviderConfig, deps: ProviderDeps = {}): NotificationProvider {
  switch (c.mode) {
    case 'console': {
      const existing = deps.consoleProviders?.get(c.channel);
      if (existing) return existing;
      const p = new ConsoleProvider(c.channel);
      deps.consoleProviders?.set(c.channel, p);
      return p;
    }
    case 'smtp': return new SmtpProvider(c.smtp, deps.mailTransport);
    case 'esms': return new EsmsProvider(c, deps.fetchImpl);
    case 'speedsms': return new SpeedSmsProvider(c, deps.fetchImpl);
    case 'zns': return new ZaloZnsProvider(c, deps.fetchImpl);
  }
}

/**
 * Tài khoản gửi CHUNG của nền tảng (cửa hàng chọn chế độ "dùng chung" sẽ bị tính vào hạn mức tin nhắn của gói).
 * Cấu hình bằng biến môi trường; thiếu thì kênh đó không có tài khoản chung.
 */
export function sharedProvidersFromEnv(env: Record<string, string | undefined>): Partial<Record<Channel, ProviderConfig>> {
  const out: Partial<Record<Channel, ProviderConfig>> = {};
  if (env.SHARED_SMTP_HOST && env.SHARED_SMTP_FROM) {
    out.email = { channel: 'email', mode: 'smtp', smtp: { host: env.SHARED_SMTP_HOST, port: Number(env.SHARED_SMTP_PORT ?? 587), secure: env.SHARED_SMTP_SECURE === 'true', user: env.SHARED_SMTP_USER, pass: env.SHARED_SMTP_PASS, from: env.SHARED_SMTP_FROM } };
  }
  if (env.SHARED_SMS_PROVIDER === 'esms' && env.SHARED_SMS_API_KEY && env.SHARED_SMS_SECRET) {
    out.sms = { channel: 'sms', mode: 'esms', apiKey: env.SHARED_SMS_API_KEY, secretKey: env.SHARED_SMS_SECRET, brandname: env.SHARED_SMS_BRANDNAME };
  } else if (env.SHARED_SMS_PROVIDER === 'speedsms' && env.SHARED_SMS_API_KEY) {
    out.sms = { channel: 'sms', mode: 'speedsms', accessToken: env.SHARED_SMS_API_KEY, sender: env.SHARED_SMS_BRANDNAME };
  }
  if (env.SHARED_ZALO_TOKEN && env.SHARED_ZALO_TEMPLATE_ID) out.zalo = { channel: 'zalo', mode: 'zns', accessToken: env.SHARED_ZALO_TOKEN, templateId: env.SHARED_ZALO_TEMPLATE_ID };
  return out;
}

