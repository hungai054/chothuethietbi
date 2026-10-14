import { defineConfig } from '@playwright/test';

// Khóa mã hóa CHỈ DÙNG CHO TEST (32 byte base64). Môi trường thật phải đặt MASTER_KEY riêng.
const TEST_MASTER_KEY = Buffer.alloc(32, 'rentpro-e2e-test-key').toString('base64');

// Cổng thu tiền thuê bao CHỈ DÙNG CHO TEST: tài khoản VietQR giả và khóa PayOS giả (webhook do test tự ký).
export const E2E_PAYOS_CHECKSUM = 'e2e-payos-checksum-not-for-production';
export const E2E_ADMIN_SECRET = 'e2e-admin-secret-not-for-production-0123456789';
const BILLING_TEST_ENV = {
  PAYOS_CLIENT_ID: 'e2e', PAYOS_API_KEY: 'e2e', PAYOS_CHECKSUM_KEY: E2E_PAYOS_CHECKSUM,
  BILLING_BANK_BIN: '970436', BILLING_BANK_ACCOUNT: '0011004123456', BILLING_BANK_NAME: 'CONG TY RENTPRO',
};

// Dùng Chrome cài sẵn trên máy (channel) nên không phải tải trình duyệt riêng.
export default defineConfig({
  globalSetup: './global-setup.ts',
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { channel: 'chrome', baseURL: 'http://demo.localhost:3000', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node node_modules/next/dist/bin/next start -p 3000', cwd: '../apps/web', url: 'http://localhost:3000/api/healthz', reuseExistingServer: true, timeout: 60_000, env: { MASTER_KEY: TEST_MASTER_KEY, FILE_URL_SECRET: 'e2e-file-url-secret-not-for-production', ...BILLING_TEST_ENV } },
    { command: 'node node_modules/next/dist/bin/next start -p 3001', cwd: '../apps/admin', url: 'http://localhost:3001/login', reuseExistingServer: true, timeout: 60_000, env: { MASTER_KEY: TEST_MASTER_KEY, ADMIN_SECRET: E2E_ADMIN_SECRET } },
  ],
});
