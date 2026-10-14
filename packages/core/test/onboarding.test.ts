import { describe, expect, it } from 'vitest';
import { INDUSTRY_TEMPLATES, templateByKey, validateTemplates } from '../src';

describe('mẫu ngành', () => {
  it('dữ liệu mẫu hợp lệ (tiền tố duy nhất, có giá, giá tuần hợp lý)', () => {
    expect(validateTemplates()).toEqual([]);
    expect(INDUSTRY_TEMPLATES.length).toBeGreaterThanOrEqual(4);
  });
  it('tìm theo khóa', () => {
    expect(templateByKey('camera')?.models.length).toBeGreaterThan(3);
    expect(templateByKey('khong-co')).toBeUndefined();
  });
  it('phát hiện dữ liệu sai', () => {
    const bad = [{ key: 'x', name: 'x', description: '', models: [
      { name: 'A', category: 'c', prefix: 'AB', price: { hour: null, day: 1000, week: 1000, month: null, minHours: 1 }, compensation: 1 },
      { name: 'B', category: 'c', prefix: 'AB', price: { hour: null, day: null, week: null, month: null, minHours: 1 }, compensation: 1 },
      { name: 'C', category: 'c', prefix: 'a b', price: { hour: 1, day: null, week: null, month: null, minHours: 1 }, compensation: 1 },
    ] }];
    const e = validateTemplates(bad);
    expect(e.some((x) => x.includes('trùng tiền tố'))).toBe(true);
    expect(e.some((x) => x.includes('thiếu giá'))).toBe(true);
    expect(e.some((x) => x.includes('tiền tố sai'))).toBe(true);
  });
});
