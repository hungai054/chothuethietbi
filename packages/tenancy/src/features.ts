export const FEATURE_KEYS = [
  'inventory', 'inventory.barcode', 'inventory.stocktake',
  'customers',
  'booking', 'booking.timeline',
  'contract', 'contract.e_signature', 'deposit',
  'pricing', 'payments',
  'notify.email', 'notify.sms', 'notify.zalo',
  'maintenance', 'maintenance.usage_based',
  'reports.basic', 'reports.advanced', 'reports.roi',
  'custom_fields', 'custom_roles', 'white_label', 'custom_domain',
  'extensions', 'api', 'multi_branch', 'audit.log',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureMap = Partial<Record<FeatureKey, boolean>>;
export type ResolvedFeatures = Record<FeatureKey, boolean>;

export function isFeatureKey(k: string): k is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(k);
}

export interface TenantFeatureInput {
  planFeatures: FeatureMap;
  overrides: FeatureMap;
}

/** Giá trị hiệu lực = mặc định của gói, bị ghi đè theo tenant. */
export function resolveFeatures(input: TenantFeatureInput): ResolvedFeatures {
  const out = {} as ResolvedFeatures;
  for (const k of FEATURE_KEYS) {
    out[k] = input.overrides[k] ?? input.planFeatures[k] ?? false;
  }
  return out;
}

/** Cổng duy nhất kiểm tra tính năng — dùng ở server và UI. */
export function can(features: ResolvedFeatures, key: FeatureKey): boolean {
  return features[key] === true;
}

export class FeatureDisabledError extends Error {
  constructor(public readonly key: FeatureKey) {
    super(`Tính năng "${key}" không có trong gói hiện tại.`);
    this.name = 'FeatureDisabledError';
  }
}

export function assertCan(features: ResolvedFeatures, key: FeatureKey): void {
  if (!can(features, key)) throw new FeatureDisabledError(key);
}
