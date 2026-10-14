import { describe, expect, it } from 'vitest';
import { verifyVietQr } from '@rentpro/core';
import { BillingProviderError, PayOsProvider, VietQrProvider, payosCreateSignature, payosDataSignature, providersFromEnv } from '../src';

const cfg = { clientId: 'cid', apiKey: 'key', checksumKey: 'checksum-secret' };

const signedHook = (data: Record<string, unknown>, top: Record<string, unknown> = {}) =>
  JSON.stringify({ code: '00', desc: 'success', success: true, data, signature: payosDataSignature(cfg.checksumKey, data), ...top });

const paidData = { orderCode: 123, amount: 799000, description: 'RPABCD2345', code: '00', desc: 'Thành công', reference: 'FT123', transactionDateTime: '2027-02-01 10:00:00', currency: 'VND', paymentLinkId: 'pl1', counterAccountName: null };

describe('PayOS', () => {
  it('tạo liên kết: gửi header + chữ ký đúng, đọc checkoutUrl', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ code: '00', desc: 'success', data: { checkoutUrl: 'https://pay.payos.vn/web/x', paymentLinkId: 'pl1' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new PayOsProvider(cfg, fake);
    const s = await p.createPayment({ orderCode: 42, amount: 799000, description: 'Thuê bao RentPro tháng', returnUrl: 'https://a/b', cancelUrl: 'https://a/c' });
    expect(s).toEqual({ provider: 'PAYOS', checkoutUrl: 'https://pay.payos.vn/web/x', providerRef: 'pl1' });
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers['x-client-id']).toBe('cid');
    expect(headers['x-api-key']).toBe('key');
    const body = JSON.parse(String(seen!.init.body));
    expect(body.description.length).toBeLessThanOrEqual(25);
    expect(body.signature).toBe(payosCreateSignature(cfg.checksumKey, body));
  });

  it('PayOS báo lỗi thì ném lỗi tiếng Việt', async () => {
    const fake = (async () => new Response(JSON.stringify({ code: '20', desc: 'Thiếu tham số' }), { status: 400 })) as unknown as typeof fetch;
    await expect(new PayOsProvider(cfg, fake).createPayment({ orderCode: 1, amount: 1000, description: 'x', returnUrl: 'u', cancelUrl: 'c' })).rejects.toThrow('PayOS từ chối');
  });

  it('webhook hợp lệ → thông báo đã thanh toán', () => {
    const n = new PayOsProvider(cfg).parseWebhook(signedHook(paidData));
    expect(n).toMatchObject({ orderCode: 123, amount: 799000, eventId: 'FT123' });
    expect(n!.paidAt.toISOString()).toBe('2027-02-01T03:00:00.000Z');
  });

  it('webhook sai chữ ký hoặc bị sửa số tiền bị từ chối', () => {
    const p = new PayOsProvider(cfg);
    const good = JSON.parse(signedHook(paidData));
    good.data.amount = 1;
    expect(() => p.parseWebhook(JSON.stringify(good))).toThrow(BillingProviderError);
    expect(() => p.parseWebhook(JSON.stringify({ ...JSON.parse(signedHook(paidData)), signature: 'abcd' }))).toThrow('Chữ ký');
    expect(() => p.parseWebhook('không phải json')).toThrow('JSON');
    expect(() => new PayOsProvider({ ...cfg, checksumKey: 'khác' }).parseWebhook(signedHook(paidData))).toThrow('Chữ ký');
  });

  it('webhook giao dịch chưa thành công không phải thông báo thanh toán', () => {
    expect(new PayOsProvider(cfg).parseWebhook(signedHook({ ...paidData, code: '01' }))).toBeNull();
  });
});

describe('VietQR', () => {
  it('sinh mã QR hợp lệ có số tiền và nội dung', async () => {
    const p = new VietQrProvider({ bin: '970436', account: '0011004123456', accountName: 'CONG TY RENTPRO' });
    const s = await p.createPayment({ orderCode: 1, amount: 799000, description: 'RPABCD2345', returnUrl: '', cancelUrl: '' });
    expect(verifyVietQr(s.qrPayload!)).toBe(true);
    expect(s.qrPayload).toContain('799000');
    expect(s.qrPayload).toContain('RPABCD2345');
  });
  it('tài khoản sai thì ném lỗi', () => {
    expect(() => new VietQrProvider({ bin: '12', account: '1' })).toThrow(BillingProviderError);
  });
});

describe('cấu hình từ môi trường', () => {
  it('chỉ bật nhà cung cấp đủ cấu hình', () => {
    expect(providersFromEnv({})).toEqual({});
    const x = providersFromEnv({ PAYOS_CLIENT_ID: 'a', PAYOS_API_KEY: 'b', PAYOS_CHECKSUM_KEY: 'c', BILLING_BANK_BIN: '970436', BILLING_BANK_ACCOUNT: '0011004123456' });
    expect(x.payos).toBeDefined();
    expect(x.vietqr).toBeDefined();
    expect(providersFromEnv({ PAYOS_CLIENT_ID: 'a' }).payos).toBeUndefined();
  });
});
