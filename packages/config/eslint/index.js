import { noHardcodedTenant, noExtensionImport } from './rules.js';

export const plugin = {
  meta: { name: 'rentpro' },
  rules: { 'no-hardcoded-tenant': noHardcodedTenant, 'no-extension-import': noExtensionImport },
};

/** Cấu hình flat cho code lõi (packages/*, apps/*). */
export const coreRules = [
  {
    plugins: { rentpro: plugin },
    rules: { 'rentpro/no-hardcoded-tenant': 'error', 'rentpro/no-extension-import': 'error' },
  },
];

/** Extension được import SDK nhưng vẫn không so sánh tenant cụ thể. */
export const extensionRules = [
  { plugins: { rentpro: plugin }, rules: { 'rentpro/no-hardcoded-tenant': 'error' } },
];

export default plugin;
