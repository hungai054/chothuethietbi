import tsParser from '@typescript-eslint/parser';
import { coreRules, extensionRules } from '@rentpro/config';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'packages/config/**'] },
  { files: ['**/*.{ts,tsx,js}'], languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' } },
  // Code lõi: cấm hardcode tenant và cấm import extensions/*
  ...coreRules.map((c) => ({ ...c, files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'] })),
  // Nơi DUY NHẤT được import extension: file đăng ký do `pnpm ext:sync` sinh (registry build-time)
  { files: ['**/extensions.generated.ts'], rules: { 'rentpro/no-extension-import': 'off' } },
  // Test có thể dùng slug cố định làm dữ liệu, nhưng vẫn cấm import extensions từ packages
  // Extension: được so sánh cấu hình nhưng không hardcode tenant
  ...extensionRules.map((c) => ({ ...c, files: ['extensions/**/*.ts'] })),
];
