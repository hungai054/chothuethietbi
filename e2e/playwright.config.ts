import { defineConfig } from '@playwright/test';

// Dùng Chrome cài sẵn trên máy (channel) nên không phải tải trình duyệt riêng.
export default defineConfig({
  globalSetup: './global-setup.ts',
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { channel: 'chrome', baseURL: 'http://demo.localhost:3000', trace: 'retain-on-failure' },
  webServer: [
    { command: 'node node_modules/next/dist/bin/next start -p 3000', cwd: '../apps/web', url: 'http://localhost:3000/api/healthz', reuseExistingServer: true, timeout: 60_000 },
    { command: 'node node_modules/next/dist/bin/next start -p 3001', cwd: '../apps/admin', url: 'http://localhost:3001/login', reuseExistingServer: true, timeout: 60_000 },
  ],
});
