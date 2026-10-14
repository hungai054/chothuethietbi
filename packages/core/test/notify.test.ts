import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUIET, DEFAULT_REMINDERS, DEFAULT_TEMPLATES, NOTIFY_EVENTS, NotifySettingsSchema, TemplateError, dueReminders, quietWindowEnd, renderTemplate,
  unknownVariables, upgradeNotifySettings, validateTemplate, type ReminderSubject,
} from '../src';

const H = 3_600_000;
const TZ = 'Asia/Ho_Chi_Minh';
const at = (iso: string) => new Date(iso); // ISO có múi giờ +07:00

describe('mẫu tin', () => {
  it('thay biến, biến thiếu thành rỗng, dọn khoảng trắng và dấu câu', () => {
    expect(renderTemplate('Chào {ten_khach}, đơn {ma_don} hạn {han_tra}.', { ten_khach: 'An', ma_don: 'DT-1', han_tra: '10:00' })).toBe('Chào An, đơn DT-1 hạn 10:00.');
    expect(renderTemplate('Còn {so_tien} . Link: {link_thanh_toan}', { so_tien: '5 đ' })).toBe('Còn 5 đ. Link:');
  });
  it('biến lạ bị từ chối, nêu rõ biến dùng được', () => {
    expect(unknownVariables('{ten_khach} {xyz} {xyz}')).toEqual(['xyz']);
    expect(validateTemplate('Xin {xyz}')).toMatch(/Biến không hợp lệ: \{xyz\}.*\{ten_khach\}/);
    expect(() => renderTemplate('Xin {xyz}', {})).toThrow(TemplateError);
    expect(validateTemplate('   ')).toMatch(/không được để trống/);
    expect(validateTemplate('a'.repeat(501))).toMatch(/tối đa 500/);
  });
  it('mọi mẫu mặc định hợp lệ', () => {
    for (const e of NOTIFY_EVENTS) expect(validateTemplate(DEFAULT_TEMPLATES[e])).toBeNull();
  });
});

describe('khung giờ nghỉ', () => {
  it('trong khung vắt nửa đêm: trả giờ kết thúc theo múi giờ cửa hàng', () => {
    expect(quietWindowEnd(at('2027-03-01T22:30:00+07:00'), TZ, DEFAULT_QUIET)?.toISOString()).toBe(at('2027-03-02T07:00:00+07:00').toISOString());
    expect(quietWindowEnd(at('2027-03-02T02:10:00+07:00'), TZ, DEFAULT_QUIET)?.toISOString()).toBe(at('2027-03-02T07:00:00+07:00').toISOString());
    expect(quietWindowEnd(at('2027-03-01T21:00:00+07:00'), TZ, DEFAULT_QUIET)).not.toBeNull(); // biên đầu thuộc khung
  });
  it('ngoài khung, tắt khung hoặc bắt đầu = kết thúc: gửi được ngay', () => {
    expect(quietWindowEnd(at('2027-03-01T07:00:00+07:00'), TZ, DEFAULT_QUIET)).toBeNull(); // biên cuối không thuộc khung
    expect(quietWindowEnd(at('2027-03-01T12:00:00+07:00'), TZ, DEFAULT_QUIET)).toBeNull();
    expect(quietWindowEnd(at('2027-03-01T23:00:00+07:00'), TZ, { ...DEFAULT_QUIET, enabled: false })).toBeNull();
    expect(quietWindowEnd(at('2027-03-01T23:00:00+07:00'), TZ, { enabled: true, start: '08:00', end: '08:00' })).toBeNull();
  });
  it('khung trong cùng một ngày', () => {
    const q = { enabled: true, start: '12:00', end: '13:30' };
    expect(quietWindowEnd(at('2027-03-01T12:45:00+07:00'), TZ, q)?.toISOString()).toBe(at('2027-03-01T13:30:00+07:00').toISOString());
    expect(quietWindowEnd(at('2027-03-01T13:30:00+07:00'), TZ, q)).toBeNull();
  });
  it('múi giờ khác nhau cho kết quả khác nhau', () => {
    // 22:30 giờ Việt Nam = 15:30 UTC: ở UTC thì không phải giờ nghỉ
    expect(quietWindowEnd(at('2027-03-01T22:30:00+07:00'), 'UTC', DEFAULT_QUIET)).toBeNull();
  });
});

describe('nhắc nhở đến lúc gửi', () => {
  const end = at('2027-03-10T10:00:00+07:00');
  const active: ReminderSubject = { status: 'ACTIVE', startsAt: at('2027-03-08T10:00:00+07:00'), endsAt: end, holdExpiresAt: null, returnedAt: null, balanceOwed: 0 };
  const c = DEFAULT_REMINDERS;
  const f = (b: ReminderSubject, now: Date, cfg = c) => dueReminders(b, now, cfg).map((r) => `${r.event}:${r.slot}`);

  it('trước hạn X giờ: chỉ trong cửa sổ, một lần', () => {
    expect(f(active, new Date(end.getTime() - 25 * H))).toEqual([]);
    expect(f(active, new Date(end.getTime() - 23 * H))).toEqual(['BEFORE_DUE:1']);
    expect(f(active, new Date(end.getTime() - 1000))).toEqual(['BEFORE_DUE:1']);
    expect(f(active, new Date(end.getTime() - 23 * H), { ...c, beforeDueHours: 2 })).toEqual([]);
  });
  it('đến hạn rồi quá hạn lặp theo chu kỳ, dừng sau số lần tối đa', () => {
    expect(f(active, new Date(end.getTime() + 5 * 60_000))).toEqual(['DUE:1']);
    expect(f(active, new Date(end.getTime() + 23 * H))).toEqual(['DUE:1']);
    expect(f(active, new Date(end.getTime() + 24 * H))).toEqual(['OVERDUE:1']);
    expect(f(active, new Date(end.getTime() + 50 * H))).toEqual(['OVERDUE:2']);
    expect(f(active, new Date(end.getTime() + 24 * 3 * H + 1))).toEqual(['OVERDUE:3']);
    expect(f(active, new Date(end.getTime() + 24 * 4 * H))).toEqual([]);
  });
  it('worker nghỉ lâu chỉ phát slot mới nhất, không dồn tin cũ', () => {
    expect(f(active, new Date(end.getTime() + 49 * H))).toEqual(['OVERDUE:2']);
  });
  it('tắt từng loại nhắc; chu kỳ tùy chỉnh', () => {
    expect(f(active, new Date(end.getTime() + 60_000), { ...c, events: { ...c.events, DUE: false } })).toEqual([]);
    expect(f(active, new Date(end.getTime() + 13 * H), { ...c, overdueEveryHours: 12 })).toEqual(['OVERDUE:1']);
  });
  it('đơn không còn đang thuê thì không nhắc trả', () => {
    for (const status of ['CONFIRMED', 'RETURNED', 'CLOSED', 'CANCELLED']) expect(f({ ...active, status }, new Date(end.getTime() + 2 * H))).toEqual([]);
  });
  it('giữ chỗ sắp hết hạn: trong X giờ cuối và chưa hết', () => {
    const hold: ReminderSubject = { ...active, status: 'HOLD', holdExpiresAt: at('2027-03-05T12:00:00+07:00') };
    expect(f(hold, at('2027-03-05T05:00:00+07:00'))).toEqual([]);
    expect(f(hold, at('2027-03-05T07:00:00+07:00'))).toEqual(['HOLD_EXPIRING:1']);
    expect(f(hold, at('2027-03-05T12:00:00+07:00'))).toEqual([]);
  });
  it('công nợ sau khi nhận lại: sau X giờ, nhắc lại mỗi tuần, tối đa 4 lần', () => {
    const returned = at('2027-03-10T10:00:00+07:00');
    const debt: ReminderSubject = { ...active, status: 'RETURNED', returnedAt: returned, balanceOwed: 100_000 };
    expect(f(debt, new Date(returned.getTime() + 10 * H))).toEqual([]);
    expect(f(debt, new Date(returned.getTime() + 25 * H))).toEqual(['DEBT:1']);
    expect(f(debt, new Date(returned.getTime() + (24 + 7 * 24) * H))).toEqual(['DEBT:2']);
    expect(f(debt, new Date(returned.getTime() + 400 * 24 * H))).toEqual(['DEBT:4']);
    expect(f({ ...debt, balanceOwed: 0 }, new Date(returned.getTime() + 25 * H))).toEqual([]);
  });
});

describe('cấu hình thông báo', () => {
  it('mặc định hợp lệ; khung giờ sai và mẫu sai báo tiếng Việt', () => {
    expect(upgradeNotifySettings(undefined).channels).toEqual(['sms', 'email']);
    expect(NotifySettingsSchema.safeParse({ quietHours: { enabled: true, start: '25:00', end: '07:00' } }).success).toBe(false);
    const r = NotifySettingsSchema.safeParse({ templates: { DUE: 'Xin {xyz}' } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain('Biến không hợp lệ');
    expect(NotifySettingsSchema.safeParse({ templates: { DUE: DEFAULT_TEMPLATES.DUE }, channels: ['zalo'] }).success).toBe(true);
  });
  it('dữ liệu hỏng thì quay về mặc định, không ném lỗi', () => {
    expect(upgradeNotifySettings({ channels: ['fax'] }).channels).toEqual(['sms', 'email']);
  });
});
