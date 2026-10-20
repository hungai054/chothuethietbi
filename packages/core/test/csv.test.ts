import { describe, it, expect } from 'vitest';
import { csvCell, toCsv } from '../src';

describe('csv', () => {
  it('thêm nháy trước ô có thể thành công thức', () => {
    for (const bad of ['=1+1', '+SUM(A1)', '-2', '@x', '\tcmd']) expect(csvCell(bad)).toBe(`"'${bad}"`);
    expect(csvCell('an toàn')).toBe('"an toàn"');
  });
  it('thoát nháy kép, null, đối tượng; có BOM và CRLF', () => {
    expect(csvCell('a "b"')).toBe('"a ""b"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(toCsv(['x', 'y'], [[1, 'z']])).toBe('﻿"x","y"\r\n"1","z"\r\n');
  });
});
