import { z } from 'zod';

/**
 * Chuẩn hóa số điện thoại Việt Nam về dạng nội địa 10 số (0xxxxxxxxx).
 * Chấp nhận +84…, 84…, có khoảng trắng/dấu chấm/gạch. Trả null nếu không phải số di động/cố định hợp lệ.
 */
export function normalizePhoneVN(raw: string): string | null {
  let s = raw.replace(/[\s.\-()]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (s.startsWith('0084')) s = '0' + s.slice(4);
  else if (/^84\d{9}$/.test(s)) s = '0' + s.slice(2);
  if (!/^0\d{9}$/.test(s)) return null;
  // đầu số hợp lệ: 02x (cố định), 03,05,07,08,09 (di động); 01 và 04, 06 không dùng
  return /^0(2\d|3\d|5\d|7\d|8\d|9\d)\d{7}$/.test(s) ? s : null;
}

export const CUSTOMER_TYPES = ['PERSON', 'COMPANY'] as const;
export const TRUST_LEVELS = ['NEW', 'TRUSTED', 'WATCH'] as const;
export const TRUST_LABEL = { NEW: 'Mới', TRUSTED: 'Tin cậy', WATCH: 'Cần theo dõi' } as const;

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());

export const CustomerInputSchema = z
  .object({
    type: z.enum(CUSTOMER_TYPES).default('PERSON'),
    name: z.string().trim().min(2, 'Họ tên phải có ít nhất 2 ký tự.').max(120),
    phone: z.string().transform((v, ctx) => {
      const p = normalizePhoneVN(v);
      if (!p) ctx.addIssue({ code: 'custom', message: 'Số điện thoại không hợp lệ (VD: 0901 234 567 hoặc +84 901 234 567).' });
      return p ?? '';
    }),
    email: z.preprocess(blank, z.string().trim().toLowerCase().email('Email không hợp lệ.').max(200).optional()),
    address: optText(300),
    zalo: z.preprocess(blank, z.string().trim().transform((v, ctx) => {
      const p = normalizePhoneVN(v);
      if (!p) ctx.addIssue({ code: 'custom', message: 'Số Zalo không hợp lệ.' });
      return p ?? '';
    }).optional()),
    companyName: optText(200),
    taxCode: z.preprocess(blank, z.string().trim().regex(/^\d{10}(-\d{3})?$/, 'Mã số thuế gồm 10 số (hoặc 10 số-3 số).').optional()),
    representative: optText(120),
    trustLevel: z.enum(TRUST_LEVELS).default('NEW'),
    groupId: z.preprocess(blank, z.string().uuid().optional()),
    notes: optText(1000),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'COMPANY') {
      if (!v.companyName) ctx.addIssue({ code: 'custom', path: ['companyName'], message: 'Khách doanh nghiệp cần nhập tên công ty.' });
      if (!v.taxCode) ctx.addIssue({ code: 'custom', path: ['taxCode'], message: 'Khách doanh nghiệp cần nhập mã số thuế.' });
    }
  });
export type CustomerInput = z.infer<typeof CustomerInputSchema>;

/** Gom lỗi zod thành một thông báo tiếng Việt, mỗi lỗi một dòng. */
export function firstZodMessage(e: z.ZodError): string {
  return e.issues.map((i) => i.message).join(' ');
}

// ===== Giấy tờ tùy thân =====
export const ID_DOC_TYPES = ['CCCD', 'PASSPORT', 'DRIVER_LICENSE'] as const;
export type IdDocType = (typeof ID_DOC_TYPES)[number];
export const ID_DOC_LABEL: Record<IdDocType, string> = { CCCD: 'CCCD', PASSPORT: 'Hộ chiếu', DRIVER_LICENSE: 'Giấy phép lái xe' };

/** Phiên bản điều khoản xử lý dữ liệu cá nhân (Nghị định 13/2023/NĐ-CP) mà khách đã đồng ý. */
export const PRIVACY_CONSENT_VERSION = '2026-10-v1';

export function normalizeIdNumber(type: IdDocType, raw: string): string | null {
  const s = raw.replace(/[\s.\-]/g, '').toUpperCase();
  if (type === 'CCCD') return /^\d{9}$|^\d{12}$/.test(s) ? s : null; // CMND 9 số hoặc CCCD 12 số
  if (type === 'DRIVER_LICENSE') return /^\d{12}$/.test(s) ? s : null;
  return /^[A-Z]\d{7,8}$|^[A-Z0-9]{6,9}$/.test(s) ? s : null; // hộ chiếu
}

export const maskIdNumber = (last4: string) => `••••${last4}`;
export const idLast4 = (n: string) => n.slice(-4);

export const ID_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Nhận dạng ảnh bằng chữ ký file (không tin phần mở rộng/Content-Type do client gửi). */
export function sniffImage(buf: Uint8Array): { ext: 'jpg' | 'png' | 'webp'; mime: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 12 && String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...buf.subarray(8, 12)) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
