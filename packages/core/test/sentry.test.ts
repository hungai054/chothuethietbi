import { describe, it, expect } from 'vitest';
import { buildEnvelope, buildEvent, createReporter, parseDsn, safeUrl, scrub } from '../src';

const DSN = 'https://abc123@o1.ingest.example.io/4500';

describe('sentry không SDK', () => {
  it('parseDsn: đúng → địa chỉ envelope; sai/rỗng → null', () => {
    expect(parseDsn(DSN)).toEqual({ key: 'abc123', projectId: '4500', url: 'https://o1.ingest.example.io/api/4500/envelope/' });
    expect(parseDsn('https://k@host/sub/path/7')!.url).toBe('https://host/sub/path/api/7/envelope/');
    for (const bad of [undefined, '', 'không phải url', 'ftp://k@h/1', 'https://host/1', 'https://k@host/']) expect(parseDsn(bad as string)).toBeNull();
  });

  it('scrub ẩn khóa nhạy cảm, cắt chuỗi dài, giới hạn độ sâu', () => {
    const r = scrub({ password: 'x', user: { Authorization: 'Bearer y', name: 'An', phone: '0901' }, long: 'a'.repeat(900), deep: { a: { b: { c: { d: { e: 1 } } } } } }) as any;
    expect(r.password).toBe('[đã ẩn]');
    expect(r.user.Authorization).toBe('[đã ẩn]');
    expect(r.user.phone).toBe('[đã ẩn]');
    expect(r.user.name).toBe('An');
    expect(r.long.length).toBe(501);
    expect(JSON.stringify(r.deep)).toContain('[quá sâu]');
  });

  it('safeUrl bỏ chuỗi truy vấn (token)', () => {
    expect(safeUrl('/pay/abc?token=secret&x=1')).toBe('/pay/abc');
    expect(safeUrl('http://shop.localhost:3000/api/v1/customers?q=0901')).toBe('/api/v1/customers');
  });

  it('buildEvent/buildEnvelope: có exception, thẻ, không lộ dữ liệu nhạy cảm; envelope đúng 3 dòng', () => {
    const ev = buildEvent(new TypeError('hỏng'), { tags: { route: '/x' }, extra: { token: 'zzz', n: 1 } }, { environment: 'test', service: 'web', release: '1.2.3' }, new Date('2027-01-01T00:00:00Z'), 'e'.repeat(32));
    expect(ev).toMatchObject({ level: 'error', environment: 'test', release: '1.2.3', tags: { service: 'web', route: '/x' }, extra: { token: '[đã ẩn]', n: 1 } });
    expect(ev.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'hỏng' });
    const env = buildEnvelope(ev, DSN).split('\n');
    expect(env).toHaveLength(3);
    expect(JSON.parse(env[1]!)).toMatchObject({ type: 'event', length: new TextEncoder().encode(env[2]!).length });
    expect(JSON.parse(env[0]!).dsn).toBe(DSN);
  });

  it('reporter: không DSN thì tắt; có DSN gửi POST kèm khóa; lỗi mạng không ném; gộp lỗi trùng; giới hạn tốc độ', async () => {
    expect(await createReporter({ service: 'web' }).capture(new Error('x'))).toBe(false);
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: true } as Response; }) as unknown as typeof fetch;
    let t = Date.parse('2027-01-01T00:00:00Z');
    const rep = createReporter({ dsn: DSN, service: 'web', fetchImpl: ok, now: () => new Date(t), maxPerMinute: 3 });
    expect(rep.enabled).toBe(true);
    expect(await rep.capture(new Error('một'))).toBe(true);
    expect(calls[0]!.url).toBe('https://o1.ingest.example.io/api/4500/envelope/');
    expect((calls[0]!.init.headers as Record<string, string>)['x-sentry-auth']).toContain('sentry_key=abc123');
    expect(await rep.capture(new Error('một'))).toBe(false); // trùng trong 60 giây
    expect(await rep.capture(new Error('hai'))).toBe(true);
    expect(await rep.capture(new Error('ba'))).toBe(true);
    expect(await rep.capture(new Error('bốn'))).toBe(false); // vượt 3 lần/phút
    t += 61_000;
    expect(await rep.capture(new Error('bốn'))).toBe(true);
    const bad = createReporter({ dsn: DSN, service: 'w', fetchImpl: (async () => { throw new Error('mạng'); }) as unknown as typeof fetch });
    await expect(bad.capture(new Error('x'))).resolves.toBe(false);
  });
});
