import { describe, it, expect } from 'vitest';
import { createTestContext, parseExtensionConfig, validateDefinition, type Quote } from '@rentpro/extension-sdk';
import ext from '../src';

describe('__CODE__', () => {
  it('định nghĩa hợp lệ và tương thích SDK', () => {
    expect(validateDefinition(ext)).toEqual([]);
  });
  it('cấu hình mặc định', () => {
    expect(parseExtensionConfig(ext, {})).toEqual({ ok: true, config: { uplift: 10 } });
  });
  it('móc giá thêm dòng phụ thu', () => {
    const ctx = createTestContext({ config: { uplift: 10 } });
    const out = ext.hooks!['pricing.adjust']!(ctx, { subtotal: 500_000 } as Quote, { start: new Date(), end: new Date() });
    expect(out).toEqual([{ label: 'Phụ thu 10%', amount: 50_000, source: 'extension' }]);
  });
});
