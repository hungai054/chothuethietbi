import { z } from 'zod';

// ===== Thương hiệu (white-label) =====

export const PRODUCT_NAME = 'RentPro';
export const DEFAULT_PRIMARY = '#0f172a';
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const LOGO_MAX_BYTES = 1024 * 1024;

export const BrandingSchema = z
  .object({
    v: z.literal(1).default(1),
    displayName: z.string().trim().max(60).optional(),
    primaryColor: z.string().regex(HEX_COLOR, 'Màu phải có dạng #RRGGBB (VD #0f172a).').optional(),
    logoPath: z.string().max(300).optional(),
    faviconPath: z.string().max(300).optional(),
    /** Tên người gửi hiển thị trong email/tin nhắn gửi khách */
    emailFromName: z.string().trim().max(80).optional(),
    /** Dòng chữ cuối trang PDF/phiếu in */
    footerText: z.string().trim().max(200).optional(),
    /** Ẩn dòng "Cung cấp bởi RentPro" (chỉ có hiệu lực ở gói có white-label) */
    hideProductBrand: z.boolean().optional(),
  })
  .strict();
export type Branding = z.infer<typeof BrandingSchema>;

export interface ResolvedBranding {
  displayName: string | null;
  primaryColor: string;
  textOnPrimary: '#ffffff' | '#000000';
  hasLogo: boolean;
  hasFavicon: boolean;
  emailFromName: string | null;
  footerText: string | null;
  hideProductBrand: boolean;
}

/** Màu chữ đọc được trên nền `hex` (theo độ sáng tương đối WCAG). */
export function contrastText(hex: string): '#ffffff' | '#000000' {
  const m = HEX_COLOR.test(hex) ? hex.slice(1) : DEFAULT_PRIMARY.slice(1);
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(m.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  return lum > 0.4 ? '#000000' : '#ffffff';
}

/** `whiteLabel`: gói có tính năng white-label. Không có thì mọi tùy biến thương hiệu bị bỏ qua (về mặc định của sản phẩm). */
export function resolveBranding(raw: unknown, whiteLabel: boolean): ResolvedBranding {
  const p = whiteLabel && raw && typeof raw === 'object' ? BrandingSchema.safeParse({ v: 1, ...(raw as object) }) : null;
  const b: Branding = p?.success ? p.data : { v: 1 };
  const color = b.primaryColor ?? DEFAULT_PRIMARY;
  return {
    displayName: b.displayName || null, primaryColor: color, textOnPrimary: contrastText(color), hasLogo: !!b.logoPath, hasFavicon: !!b.faviconPath,
    emailFromName: b.emailFromName || null, footerText: b.footerText || null, hideProductBrand: b.hideProductBrand === true,
  };
}
