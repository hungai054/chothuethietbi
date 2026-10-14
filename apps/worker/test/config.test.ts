import { describe, it, expect } from 'vitest';
import { publicUrlFrom, sharedProvidersFromEnv } from '../src/config';

describe('cấu hình worker', () => {
  it('không có biến môi trường thì không có tài khoản chung', () => {
    expect(sharedProvidersFromEnv({})).toEqual({});
  });
  it('dựng tài khoản chung theo biến môi trường, bỏ qua cấu hình thiếu', () => {
    const s = sharedProvidersFromEnv({
      SHARED_SMTP_HOST: 'smtp.x.vn', SHARED_SMTP_FROM: 'no-reply@x.vn', SHARED_SMTP_PORT: '465', SHARED_SMTP_SECURE: 'true',
      SHARED_SMS_PROVIDER: 'speedsms', SHARED_SMS_API_KEY: 'tok', SHARED_ZALO_TOKEN: 'z',
    });
    expect(s.email).toMatchObject({ mode: 'smtp', smtp: { host: 'smtp.x.vn', port: 465, secure: true } });
    expect(s.sms).toEqual({ channel: 'sms', mode: 'speedsms', accessToken: 'tok', sender: undefined });
    expect(s.zalo).toBeUndefined(); // thiếu mã mẫu tin
    expect(sharedProvidersFromEnv({ SHARED_SMS_PROVIDER: 'esms', SHARED_SMS_API_KEY: 'a' }).sms).toBeUndefined(); // eSMS cần cả secret
  });
  it('mẫu địa chỉ cửa hàng', () => {
    expect(publicUrlFrom({})).toBeUndefined();
    expect(publicUrlFrom({ PUBLIC_URL_TEMPLATE: 'https://{slug}.rentpro.vn' })!('demo')).toBe('https://demo.rentpro.vn');
  });
});
