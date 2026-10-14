import { readFileSync } from 'node:fs';
import type { NextConfig } from 'next';

// Danh sách extension do `pnpm ext:sync` sinh: Next cần biên dịch các gói TypeScript này trong workspace
const extensions: string[] = JSON.parse(readFileSync(new URL('./extensions.json', import.meta.url), 'utf8'));

const config: NextConfig = {
  transpilePackages: ['@rentpro/billing', '@rentpro/core', '@rentpro/db', '@rentpro/tenancy', '@rentpro/extension-sdk', '@rentpro/notifications', ...extensions],
  serverExternalPackages: ['pg', '@node-rs/argon2'],
};
export default config;
