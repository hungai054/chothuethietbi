import { describe, it, expect } from 'vitest';
import { backupFileName, isSafeDbName, parseBackupName, selectBackupsToPrune, verifyDbName } from '../src';

describe('sao lưu: tên và dọn', () => {
  it('đặt tên theo UTC và đọc lại được', () => {
    const d = new Date('2027-03-04T05:06:07Z');
    expect(backupFileName(d)).toBe('rentpro-20270304-050607.dump');
    expect(parseBackupName('rentpro-20270304-050607.dump')).toEqual(d);
    for (const bad of ['rentpro-2027.dump', 'x.dump', 'rentpro-20271304-050607.dump.sha256', '../rentpro-20270304-050607.dump']) expect(parseBackupName(bad)).toBeNull();
  });
  it('chỉ chọn xóa bản cũ vượt số lượng giữ; không đụng tệp lạ; luôn giữ ít nhất 1', () => {
    const names = ['rentpro-20270101-000000.dump', 'rentpro-20270103-000000.dump', 'rentpro-20270102-000000.dump', 'ghi-chu.txt', 'rentpro-20270101-000000.dump.sha256'];
    expect(selectBackupsToPrune(names, 2)).toEqual(['rentpro-20270101-000000.dump']);
    expect(selectBackupsToPrune(names, 10)).toEqual([]);
    expect(selectBackupsToPrune(names, 0)).toEqual(['rentpro-20270102-000000.dump', 'rentpro-20270101-000000.dump']);
    expect(selectBackupsToPrune(names, Number.NaN)).toEqual([]);
  });
  it('tên DB kiểm tra an toàn', () => {
    expect(isSafeDbName(verifyDbName(new Date()))).toBe(true);
    for (const bad of ['', 'A', 'x; drop', '1abc', 'a'.repeat(64), 'a-b']) expect(isSafeDbName(bad)).toBe(false);
  });
});
