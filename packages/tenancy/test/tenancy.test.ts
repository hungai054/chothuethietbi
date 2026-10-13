import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  resolveFeatures, can, assertCan, FeatureDisabledError,
  resolveLimits, assertWithinLimit, nearLimit, LimitExceededError,
  encryptSecret, decryptSecret, rotateSecret, subdomainOf, runWithTenant, currentTenant,
} from '../src';

describe('feature flags', () => {
  it('override thắng mặc định của gói', () => {
    const f = resolveFeatures({
      planFeatures: { 'booking.timeline': false, inventory: true },
      overrides: { 'booking.timeline': true, inventory: false },
    });
    expect(can(f, 'booking.timeline')).toBe(true);
    expect(can(f, 'inventory')).toBe(false);
  });
  it('không khai báo thì tắt, assertCan ném lỗi', () => {
    const f = resolveFeatures({ planFeatures: {}, overrides: {} });
    expect(can(f, 'api')).toBe(false);
    expect(() => assertCan(f, 'api')).toThrow(FeatureDisabledError);
  });
});

describe('giới hạn gói', () => {
  const plan = { equipment: 300, users: 3 };
  it('chặn khi vượt', () => {
    const l = resolveLimits(plan, {});
    expect(() => assertWithinLimit(l, 'equipment', 300)).toThrow(LimitExceededError);
    expect(() => assertWithinLimit(l, 'equipment', 299)).not.toThrow();
  });
  it('ghi đè null hoặc thiếu = không giới hạn', () => {
    const l = resolveLimits(plan, { equipment: null });
    expect(() => assertWithinLimit(l, 'equipment', 99999)).not.toThrow();
    expect(() => assertWithinLimit(l, 'branches', 99999)).not.toThrow();
  });
  it('cảnh báo 80%', () => {
    const l = resolveLimits(plan, {});
    expect(nearLimit(l, 'equipment', 240)).toBe(true);
    expect(nearLimit(l, 'equipment', 239)).toBe(false);
  });
});

describe('bí mật tenant', () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  it('mã hóa, giải mã và xoay khóa', () => {
    const old = encryptSecret('zalo-key', { current: 'k1', keys: { k1 } });
    const ring = { current: 'k2', keys: { k1, k2 } };
    expect(decryptSecret(old, ring)).toBe('zalo-key');
    const rotated = rotateSecret(old, ring);
    expect(rotated.split('.')[1]).toBe('k2');
    expect(decryptSecret(rotated, { current: 'k2', keys: { k2 } })).toBe('zalo-key');
  });
  it('phát hiện dữ liệu bị sửa', () => {
    const t = encryptSecret('x', { current: 'k1', keys: { k1 } });
    const parts = t.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), { current: 'k1', keys: { k1 } })).toThrow();
  });
});

describe('ngữ cảnh tenant', () => {
  it('tách subdomain', () => {
    expect(subdomainOf('cuahang-a.rentpro.vn:3000', 'rentpro.vn')).toBe('cuahang-a');
    expect(subdomainOf('khac.com', 'rentpro.vn')).toBeNull();
    expect(subdomainOf('a.b.rentpro.vn', 'rentpro.vn')).toBeNull();
  });
  it('thiếu ngữ cảnh thì ném lỗi', () => {
    expect(() => currentTenant()).toThrow();
    expect(runWithTenant({ tenantId: 't1' }, () => currentTenant().tenantId)).toBe('t1');
  });
});
