import { z } from 'zod';
import { DEFAULT_TERMS } from '../contract/template';

// ===== Mẫu tài liệu do tenant tự sửa: hợp đồng, phiếu thu, biên bản giao nhận =====

export const DOC_VARIABLES = ['ten_cua_hang', 'ten_khach', 'ma_don', 'so_hop_dong', 'tong_tien', 'tien_coc', 'ngay_bat_dau', 'ngay_ket_thuc'] as const;
export type DocVariable = (typeof DOC_VARIABLES)[number];
export const DOC_VARIABLE_LABEL: Record<DocVariable, string> = {
  ten_cua_hang: 'Tên cửa hàng', ten_khach: 'Tên khách', ma_don: 'Mã đơn', so_hop_dong: 'Số hợp đồng', tong_tien: 'Tổng tiền thuê', tien_coc: 'Tiền cọc',
  ngay_bat_dau: 'Ngày nhận', ngay_ket_thuc: 'Ngày trả',
};

export const MAX_TERMS = 30;
export const MAX_TERM_LENGTH = 800;
const VAR_RE = /\{([a-z_][a-z0-9_.]*)\}/g;

/** Biến hợp lệ trong mẫu: biến hệ thống hoặc `cf.<mã trường tùy chỉnh>`. */
export function unknownDocVariables(text: string, customKeys: readonly string[] = []): string[] {
  const known = new Set<string>(DOC_VARIABLES);
  const cf = new Set(customKeys.map((k) => `cf.${k}`));
  return [...new Set([...text.matchAll(VAR_RE)].map((m) => m[1]!).filter((v) => !known.has(v) && !cf.has(v) && !/^ext\.[a-z0-9_]+$/.test(v)))];
}

export function validateDocText(text: string, customKeys: readonly string[] = [], max = MAX_TERM_LENGTH): string | null {
  if (text.trim().length === 0) return 'Nội dung không được để trống.';
  if (text.length > max) return `Nội dung tối đa ${max} ký tự.`;
  const bad = unknownDocVariables(text, customKeys);
  if (bad.length) return `Biến không hợp lệ: ${bad.map((b) => `{${b}}`).join(', ')}. Dùng được: ${[...DOC_VARIABLES, ...customKeys.map((k) => `cf.${k}`)].map((v) => `{${v}}`).join(' ')}.`;
  return null;
}

/** Thay biến; biến không có giá trị thành chuỗi rỗng. Gọi validateDocText trước nếu cần báo lỗi. */
export function renderDocText(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(VAR_RE, (_, k: string) => vars[k] ?? '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

const line = (max: number) => z.string().trim().min(1, 'Không được để trống.').max(max, `Tối đa ${max} ký tự.`);

export const DocTemplatesSchema = z
  .object({
    v: z.literal(1).default(1),
    contract: z.object({ title: line(100), terms: z.array(line(MAX_TERM_LENGTH)).min(1, 'Hợp đồng cần ít nhất một điều khoản.').max(MAX_TERMS, `Tối đa ${MAX_TERMS} điều khoản.`) }).optional(),
    receipt: z.object({ title: line(100), footer: z.string().trim().max(300).default('') }).optional(),
    handover: z.object({ title: line(100), footer: z.string().trim().max(300).default('') }).optional(),
  })
  .strict();
export type DocTemplates = z.infer<typeof DocTemplatesSchema>;

export const DEFAULT_DOC_TEMPLATES = {
  contract: { title: 'HỢP ĐỒNG CHO THUÊ THIẾT BỊ', terms: [...DEFAULT_TERMS] },
  receipt: { title: 'PHIẾU THU', footer: 'Cảm ơn quý khách.' },
  handover: { title: 'BIÊN BẢN GIAO NHẬN THIẾT BỊ', footer: '' },
} as const;

export interface ResolvedTemplates {
  contract: { title: string; terms: string[] };
  receipt: { title: string; footer: string };
  handover: { title: string; footer: string };
}

/** Mẫu hiệu lực = mẫu tenant đã sửa, thiếu phần nào dùng mặc định. Dữ liệu hỏng thì dùng mặc định toàn bộ. */
export function resolveTemplates(raw: unknown): ResolvedTemplates {
  const p = raw && typeof raw === 'object' ? DocTemplatesSchema.safeParse({ v: 1, ...(raw as object) }) : null;
  const t: Partial<DocTemplates> = p?.success ? p.data : {};
  return {
    contract: { title: t.contract?.title ?? DEFAULT_DOC_TEMPLATES.contract.title, terms: [...(t.contract?.terms ?? DEFAULT_DOC_TEMPLATES.contract.terms)] },
    receipt: { title: t.receipt?.title ?? DEFAULT_DOC_TEMPLATES.receipt.title, footer: t.receipt?.footer ?? DEFAULT_DOC_TEMPLATES.receipt.footer },
    handover: { title: t.handover?.title ?? DEFAULT_DOC_TEMPLATES.handover.title, footer: t.handover?.footer ?? DEFAULT_DOC_TEMPLATES.handover.footer },
  };
}
