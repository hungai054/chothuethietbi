import { describe, it, expect } from 'vitest';
import { zonedTimeToUtc, utcToZonedInput } from '../src';

describe('đổi giờ địa phương sang UTC', () => {
  it('giờ Việt Nam là UTC+7', () => {
    expect(zonedTimeToUtc('2026-11-02T08:00', 'Asia/Ho_Chi_Minh')?.toISOString()).toBe('2026-11-02T01:00:00.000Z');
    expect(zonedTimeToUtc('2026-11-02T00:30', 'Asia/Ho_Chi_Minh')?.toISOString()).toBe('2026-11-01T17:30:00.000Z');
  });
  it('xử lý múi giờ có giờ mùa hè (Mỹ/New York, mùa đông UTC-5, mùa hè UTC-4)', () => {
    expect(zonedTimeToUtc('2026-01-15T12:00', 'America/New_York')?.toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-15T12:00', 'America/New_York')?.toISOString()).toBe('2026-07-15T16:00:00.000Z');
  });
  it('qua lại với utcToZonedInput', () => {
    const d = zonedTimeToUtc('2026-11-02T22:15', 'Asia/Ho_Chi_Minh')!;
    expect(utcToZonedInput(d, 'Asia/Ho_Chi_Minh')).toBe('2026-11-02T22:15');
    expect(utcToZonedInput(new Date('2026-11-02T17:00:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-11-03T00:00');
  });
  it('từ chối đầu vào sai: định dạng, ngày không tồn tại, múi giờ lạ', () => {
    expect(zonedTimeToUtc('02/11/2026 08:00', 'Asia/Ho_Chi_Minh')).toBeNull();
    expect(zonedTimeToUtc('2026-02-31T08:00', 'Asia/Ho_Chi_Minh')).toBeNull();
    expect(zonedTimeToUtc('2026-11-02T25:00', 'Asia/Ho_Chi_Minh')).toBeNull();
    expect(zonedTimeToUtc('2026-11-02T08:00', 'Khong/Co')).toBeNull();
  });
});
