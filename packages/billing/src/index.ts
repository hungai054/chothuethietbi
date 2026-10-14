import { createHmac, timingSafeEqual } from 'node:crypto';
import { buildVietQrPayload, sanitizeMemo, validateBankAccount, type BankAccount } from '@rentpro/core';

/**
 * Cổng thu tiền thuê bao. Hai adapter: PayOS (tạo liên kết thanh toán, webhook tự kích hoạt) và VietQR
 * (chuyển khoản, quản trị viên xác nhận thủ công). Chỉ chứa phần nói chuyện với nhà cung cấp; ghi sổ nằm ở packages/db.
 */

export class BillingProviderError extends Error {
  constructor(message: string) { super(message); this.name = 'BillingProviderError'; }
}

export interface PaymentRequest {
  /** Số nguyên dương duy nhất cho mỗi lần tạo liên kết (PayOS yêu cầu) */
  orderCode: number;
  amount: number;
  /** Nội dung chuyển khoản / mô tả (không dấu, ngắn) */
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PaymentSession {
  provider: 'PAYOS' | 'VIETQR';
  /** Liên kết thanh toán (PayOS) */
  checkoutUrl?: string;
  /** Nội dung mã QR (VietQR chuẩn EMV) */
  qrPayload?: string;
  providerRef?: string;
}

export interface PaidNotice {
  orderCode: number;
  amount: number;
  /** Mã giao dịch phía nhà cung cấp, dùng làm khóa chống xử lý trùng */
  eventId: string;
  paidAt: Date;
}

export interface BillingProvider {
  readonly code: 'PAYOS' | 'VIETQR';
  createPayment(req: PaymentRequest): Promise<PaymentSession>;
  /** Kiểm tra chữ ký và đọc webhook. Trả null nếu không phải thông báo đã thanh toán; ném lỗi nếu chữ ký sai. */
  parseWebhook?(rawBody: string): PaidNotice | null;
}

// ===== PayOS =====
export interface PayOsConfig { clientId: string; apiKey: string; checksumKey: string; baseUrl?: string }
type Fetch = typeof fetch;

const hmacHex = (key: string, data: string) => createHmac('sha256', key).update(data).digest('hex');

/** Chữ ký tạo liên kết: các trường theo thứ tự chữ cái, dạng key=value nối bằng & (theo tài liệu PayOS). */
export function payosCreateSignature(checksumKey: string, r: { amount: number; cancelUrl: string; description: string; orderCode: number; returnUrl: string }): string {
  return hmacHex(checksumKey, `amount=${r.amount}&cancelUrl=${r.cancelUrl}&description=${r.description}&orderCode=${r.orderCode}&returnUrl=${r.returnUrl}`);
}

/** Chữ ký webhook: mọi trường của `data` sắp theo khóa, giá trị null/undefined thành chuỗi rỗng. */
export function payosDataSignature(checksumKey: string, data: Record<string, unknown>): string {
  const s = Object.keys(data).sort().map((k) => `${k}=${data[k] === null || data[k] === undefined || data[k] === 'null' || data[k] === 'undefined' ? '' : String(data[k])}`).join('&');
  return hmacHex(checksumKey, s);
}

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

export class PayOsProvider implements BillingProvider {
  readonly code = 'PAYOS' as const;
  constructor(private readonly cfg: PayOsConfig, private readonly doFetch: Fetch = fetch) {}

  async createPayment(req: PaymentRequest): Promise<PaymentSession> {
    if (!Number.isSafeInteger(req.orderCode) || req.orderCode <= 0) throw new BillingProviderError('Mã đơn PayOS không hợp lệ.');
    const description = sanitizeMemo(req.description, 25);
    const body = {
      orderCode: req.orderCode, amount: req.amount, description, returnUrl: req.returnUrl, cancelUrl: req.cancelUrl,
      signature: payosCreateSignature(this.cfg.checksumKey, { amount: req.amount, cancelUrl: req.cancelUrl, description, orderCode: req.orderCode, returnUrl: req.returnUrl }),
    };
    const res = await this.doFetch(`${this.cfg.baseUrl ?? 'https://api-merchant.payos.vn'}/v2/payment-requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-id': this.cfg.clientId, 'x-api-key': this.cfg.apiKey },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { code?: string; desc?: string; data?: { checkoutUrl?: string; paymentLinkId?: string } } | null;
    if (!res.ok || !json || json.code !== '00' || !json.data?.checkoutUrl) throw new BillingProviderError(`PayOS từ chối tạo liên kết: ${json?.desc ?? res.status}`);
    return { provider: 'PAYOS', checkoutUrl: json.data.checkoutUrl, providerRef: json.data.paymentLinkId };
  }

  parseWebhook(rawBody: string): PaidNotice | null {
    let msg: { code?: string; success?: boolean; data?: Record<string, unknown>; signature?: string };
    try { msg = JSON.parse(rawBody); } catch { throw new BillingProviderError('Webhook không phải JSON.'); }
    if (!msg.data || typeof msg.signature !== 'string') throw new BillingProviderError('Webhook thiếu dữ liệu hoặc chữ ký.');
    if (!safeEqualHex(payosDataSignature(this.cfg.checksumKey, msg.data), msg.signature)) throw new BillingProviderError('Chữ ký webhook không hợp lệ.');
    if (msg.code !== '00' || msg.success === false || msg.data.code !== '00') return null;
    const orderCode = Number(msg.data.orderCode);
    const amount = Number(msg.data.amount);
    if (!Number.isSafeInteger(orderCode) || !Number.isSafeInteger(amount)) throw new BillingProviderError('Webhook sai định dạng.');
    const when = typeof msg.data.transactionDateTime === 'string' ? new Date(`${msg.data.transactionDateTime.replace(' ', 'T')}+07:00`) : new Date();
    return { orderCode, amount, eventId: String(msg.data.reference ?? msg.data.paymentLinkId ?? orderCode), paidAt: Number.isNaN(when.getTime()) ? new Date() : when };
  }
}

// ===== VietQR (chuyển khoản, xác nhận thủ công) =====
export class VietQrProvider implements BillingProvider {
  readonly code = 'VIETQR' as const;
  constructor(private readonly account: BankAccount) {
    const err = validateBankAccount(account);
    if (err) throw new BillingProviderError(`Tài khoản nhận tiền thuê bao chưa hợp lệ: ${err}`);
  }

  async createPayment(req: PaymentRequest): Promise<PaymentSession> {
    return { provider: 'VIETQR', qrPayload: buildVietQrPayload({ ...this.account, amount: req.amount, memo: req.description }) };
  }
}

// ===== Cấu hình từ môi trường =====
export interface BillingEnv {
  PAYOS_CLIENT_ID?: string; PAYOS_API_KEY?: string; PAYOS_CHECKSUM_KEY?: string;
  BILLING_BANK_BIN?: string; BILLING_BANK_ACCOUNT?: string; BILLING_BANK_NAME?: string;
}

/** Nhà cung cấp đang cấu hình đủ. Thiếu cả hai thì danh sách rỗng (giao diện báo "liên hệ để thanh toán"). */
export function providersFromEnv(env: BillingEnv & Record<string, string | undefined>, doFetch?: Fetch): { payos?: PayOsProvider; vietqr?: VietQrProvider; account?: BankAccount } {
  const out: { payos?: PayOsProvider; vietqr?: VietQrProvider; account?: BankAccount } = {};
  if (env.PAYOS_CLIENT_ID && env.PAYOS_API_KEY && env.PAYOS_CHECKSUM_KEY) {
    out.payos = new PayOsProvider({ clientId: env.PAYOS_CLIENT_ID, apiKey: env.PAYOS_API_KEY, checksumKey: env.PAYOS_CHECKSUM_KEY }, doFetch);
  }
  if (env.BILLING_BANK_BIN && env.BILLING_BANK_ACCOUNT) {
    out.account = { bin: env.BILLING_BANK_BIN, account: env.BILLING_BANK_ACCOUNT, accountName: env.BILLING_BANK_NAME };
    out.vietqr = new VietQrProvider(out.account);
  }
  return out;
}
