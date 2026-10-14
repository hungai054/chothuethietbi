import { randomBytes } from 'node:crypto';

// ===== Tên miền riêng =====

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.test', '.invalid', '.example', '.lan'];

/**
 * Chuẩn hóa tên miền khách nhập (bỏ http://, đường dẫn, dấu chấm cuối; chữ thường) và từ chối tên không dùng được.
 * `platformBase`: tên miền nền tảng (VD rentpro.vn): cửa hàng không được đăng ký chính nó hoặc subdomain của nó.
 */
export function normalizeDomain(raw: string, platformBase?: string): string {
  let d = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  if (d.includes(':')) throw new DomainError('Chỉ nhập tên miền, không kèm cổng (:8080).');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d)) throw new DomainError('Không dùng địa chỉ IP, hãy nhập tên miền (VD thuethietbi.vn).');
  if (d === 'localhost' || BLOCKED_SUFFIXES.some((s) => d.endsWith(s))) throw new DomainError('Tên miền nội bộ/thử nghiệm không dùng được.');
  if (!DOMAIN_RE.test(d)) throw new DomainError('Tên miền không hợp lệ (VD thuethietbi.vn hoặc app.cuahang.com).');
  const base = platformBase?.trim().toLowerCase();
  if (base && base !== 'localhost' && (d === base || d.endsWith(`.${base}`))) throw new DomainError(`Không dùng được tên miền thuộc ${base}. Hãy nhập tên miền riêng của bạn.`);
  return d;
}

export const verifyRecordName = (domain: string) => `_rentpro-verify.${domain}`;
export const makeVerifyToken = () => `rentpro-${randomBytes(18).toString('hex')}`;

export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
}

export interface DomainCheck { ok: boolean; message: string; txtOk: boolean; cnameOk: boolean | null }

/**
 * Xác minh quyền sở hữu: bản ghi TXT `_rentpro-verify.<tên miền>` phải chứa đúng mã. CNAME trỏ về `cnameTarget` chỉ để cảnh báo (cần để web chạy được).
 */
export async function checkDomain(domain: string, token: string, cnameTarget: string | null, dns: DnsResolver): Promise<DomainCheck> {
  let txtOk = false;
  try {
    const txt = await dns.resolveTxt(verifyRecordName(domain));
    txtOk = txt.some((parts) => parts.join('') === token);
  } catch {
    txtOk = false;
  }
  let cnameOk: boolean | null = null;
  if (cnameTarget) {
    try {
      cnameOk = (await dns.resolveCname(domain)).some((c) => c.replace(/\.$/, '').toLowerCase() === cnameTarget.toLowerCase());
    } catch {
      cnameOk = false;
    }
  }
  if (!txtOk) return { ok: false, txtOk, cnameOk, message: `Chưa thấy bản ghi TXT ${verifyRecordName(domain)} với đúng mã xác minh. DNS có thể mất vài phút đến vài giờ để cập nhật.` };
  if (cnameOk === false) return { ok: true, txtOk, cnameOk, message: `Đã xác minh quyền sở hữu. Lưu ý: ${domain} chưa trỏ CNAME về ${cnameTarget}, khách chưa vào web được qua tên miền này.` };
  return { ok: true, txtOk, cnameOk, message: 'Đã xác minh tên miền.' };
}
