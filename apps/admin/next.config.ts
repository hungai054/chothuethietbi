import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@rentpro/core', '@rentpro/db', '@rentpro/tenancy'],
  serverExternalPackages: ['pg', '@node-rs/argon2'],
};
export default config;
