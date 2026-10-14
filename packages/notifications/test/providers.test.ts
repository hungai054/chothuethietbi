import { describe, it, expect } from 'vitest';
import { ConsoleProvider, EsmsProvider, SmtpProvider, SpeedSmsProvider, ZaloZnsProvider, buildProvider, normalizeVnPhone, type FetchLike, type OutgoingMessage } from '../src';

const msg = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({ channel: 'sms', to: '0901234567', body: 'Xin chào', idempotencyKey: 'k1', ...over });
const reply = (status: number, body: unknown): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

describe('chuẩn hóa số điện thoại', () => {
  it('đổi về dạng 84…, từ chối số sai', () => {
    expect(normalizeVnPhone('0901 234 567')).toBe('84901234567');
    expect(normalizeVnPhone('+84901234567')).toBe('84901234567');
    expect(normalizeVnPhone('84-901-234-567')).toBe('84901234567');
    expect(normalizeVnPhone('12345')).toBeNull();
    expect(normalizeVnPhone('090123456')).toBeNull();
    expect(normalizeVnPhone('abc')).toBeNull();
  });
});

describe('Console', () => {
  it('ghi lại thay vì gửi', async () => {
    const p = new ConsoleProvider('sms');
    expect(await p.send(msg())).toEqual({ ok: true, providerId: 'console:k1' });
    expect(p.sent).toHaveLength(1);
  });
});

describe('SMTP', () => {
  it('gửi qua transport, kèm tiêu đề và khóa idempotency', async () => {
    const calls: unknown[] = [];
    const p = new SmtpProvider({ host: 'h', port: 587, secure: false, from: 'shop@x.vn' }, { sendMail: async (o) => { calls.push(o); return { messageId: '<m1>' }; } });
    expect(await p.send(msg({ channel: 'email', to: 'a@b.vn', subject: 'Nhắc trả' }))).toEqual({ ok: true, providerId: '<m1>' });
    expect(calls[0]).toMatchObject({ from: 'shop@x.vn', to: 'a@b.vn', subject: 'Nhắc trả', text: 'Xin chào', headers: { 'X-Idempotency-Key': 'k1' } });
  });
  it('email sai bị từ chối, không thử lại; lỗi mạng thì thử lại được; 5xx vĩnh viễn thì không', async () => {
    const t = (e: Error) => ({ sendMail: async () => { throw e; } });
    expect(await new SmtpProvider({ host: 'h', port: 1, secure: false, from: 'f' }, t(new Error('x'))).send(msg({ channel: 'email', to: 'khong-phai-email' }))).toMatchObject({ ok: false, retryable: false });
    expect(await new SmtpProvider({ host: 'h', port: 1, secure: false, from: 'f' }, t(new Error('ECONNREFUSED'))).send(msg({ channel: 'email', to: 'a@b.vn' }))).toMatchObject({ ok: false, retryable: true });
    expect(await new SmtpProvider({ host: 'h', port: 1, secure: false, from: 'f' }, t(Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }))).send(msg({ channel: 'email', to: 'a@b.vn' }))).toMatchObject({ ok: false, retryable: false });
  });
});

describe('SMS và Zalo (HTTP)', () => {
  it('eSMS: gửi đúng nội dung/số chuẩn hóa; mã 100 là thành công, mã khác là lỗi', async () => {
    let body: Record<string, unknown> = {};
    const f: FetchLike = async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => JSON.stringify({ CodeResult: '100', SMSID: 'S1' }) }; };
    expect(await new EsmsProvider({ apiKey: 'a', secretKey: 's', brandname: 'SHOP' }, f).send(msg())).toEqual({ ok: true, providerId: 'S1' });
    expect(body).toMatchObject({ ApiKey: 'a', SecretKey: 's', Phone: '84901234567', Content: 'Xin chào', Brandname: 'SHOP', RequestId: 'k1' });
    expect(await new EsmsProvider({ apiKey: 'a', secretKey: 's' }, reply(200, { CodeResult: '104', ErrorMessage: 'Sai brandname' })).send(msg())).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining('Sai brandname') });
  });
  it('lỗi 5xx/429 thử lại được, 4xx thì không; số sai không gọi mạng', async () => {
    expect(await new EsmsProvider({ apiKey: 'a', secretKey: 's' }, reply(503, 'busy')).send(msg())).toMatchObject({ ok: false, retryable: true });
    expect(await new SpeedSmsProvider({ accessToken: 't' }, reply(429, 'slow')).send(msg())).toMatchObject({ ok: false, retryable: true });
    expect(await new SpeedSmsProvider({ accessToken: 't' }, reply(401, 'no')).send(msg())).toMatchObject({ ok: false, retryable: false });
    const never: FetchLike = async () => { throw new Error('không được gọi'); };
    expect(await new ZaloZnsProvider({ accessToken: 't', templateId: '1' }, never).send(msg({ to: '123', channel: 'zalo' }))).toMatchObject({ ok: false, retryable: false, error: expect.stringContaining('Số điện thoại') });
  });
  it('lỗi mạng được coi là tạm thời', async () => {
    const down: FetchLike = async () => { throw new Error('ENOTFOUND'); };
    expect(await new SpeedSmsProvider({ accessToken: 't' }, down).send(msg())).toMatchObject({ ok: false, retryable: true });
  });
  it('SpeedSMS và Zalo nhận phản hồi thành công', async () => {
    expect(await new SpeedSmsProvider({ accessToken: 't' }, reply(200, { status: 'success', data: { tranId: 7 } })).send(msg())).toEqual({ ok: true, providerId: '7' });
    expect(await new SpeedSmsProvider({ accessToken: 't' }, reply(200, { status: 'error', message: 'het tien' })).send(msg())).toMatchObject({ ok: false });
    let sent: Record<string, unknown> = {};
    const f: FetchLike = async (_u, init) => { sent = { ...JSON.parse(init.body), token: init.headers.access_token }; return { ok: true, status: 200, text: async () => JSON.stringify({ error: 0, data: { msg_id: 'Z1' } }) }; };
    expect(await new ZaloZnsProvider({ accessToken: 'tok', templateId: '99' }, f).send(msg({ channel: 'zalo' }))).toEqual({ ok: true, providerId: 'Z1' });
    expect(sent).toMatchObject({ phone: '84901234567', template_id: '99', template_data: { noi_dung: 'Xin chào' }, tracking_id: 'k1', token: 'tok' });
    expect(await new ZaloZnsProvider({ accessToken: 'tok', templateId: '99' }, reply(200, { error: -124, message: 'token het han' })).send(msg({ channel: 'zalo' }))).toMatchObject({ ok: false });
  });
});

describe('buildProvider', () => {
  it('console dùng chung một thể hiện theo kênh để kiểm tra được', () => {
    const map = new Map();
    const a = buildProvider({ channel: 'sms', mode: 'console' }, { consoleProviders: map });
    const b = buildProvider({ channel: 'sms', mode: 'console' }, { consoleProviders: map });
    expect(a).toBe(b);
    expect(buildProvider({ channel: 'zalo', mode: 'zns', accessToken: 't', templateId: '1' }).name).toBe('zalo-zns');
    expect(buildProvider({ channel: 'sms', mode: 'esms', apiKey: 'a', secretKey: 's' }).name).toBe('esms');
  });
});
