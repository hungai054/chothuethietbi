import { ValidationError } from '@rentpro/db';

/** Số tiền nhập tay: bỏ dấu chấm/phẩy/khoảng trắng ngăn cách nghìn. */
export function parseMoney(v: FormDataEntryValue | null, label = 'Số tiền'): number {
  const s = String(v ?? '').replace(/[.,\s]/g, '');
  if (!/^\d+$/.test(s)) throw new ValidationError(`${label} phải là số nguyên (đồng).`);
  return Number(s);
}

/** Ảnh dạng data URL (chữ ký vẽ trên canvas) → byte. */
export function dataUrlBytes(v: FormDataEntryValue | null): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(v ?? ''));
  return m ? new Uint8Array(Buffer.from(m[1]!, 'base64')) : null;
}

/** Các file ảnh được chọn trong form (bỏ ô trống). */
export async function photosOf(f: FormData, name: string): Promise<{ data: Uint8Array }[]> {
  const out: { data: Uint8Array }[] = [];
  for (const x of f.getAll(name)) if (typeof x !== 'string' && x.size > 0) out.push({ data: new Uint8Array(await x.arrayBuffer()) });
  return out;
}

export const okUrl = (back: string, m: string) => `${back}${back.includes('?') ? '&' : '?'}ok=${encodeURIComponent(m)}`;

/** Phụ kiện nhập theo dòng: "Tên | số cần | số có" hoặc "Tên | số lượng" (cần = có). */
export function parseAccessories(v: FormDataEntryValue | null): { name: string; expected: number; actual: number }[] {
  const out: { name: string; expected: number; actual: number }[] = [];
  for (const line of String(v ?? '').split('\n')) {
    const p = line.split('|').map((x) => x.trim());
    if (!p[0]) continue;
    const e = p[1] === undefined || p[1] === '' ? 1 : Number(p[1]);
    const a = p[2] === undefined || p[2] === '' ? e : Number(p[2]);
    if (!Number.isInteger(e) || !Number.isInteger(a) || e < 0 || a < 0) throw new ValidationError(`Phụ kiện "${p[0]}": số lượng phải là số nguyên không âm.`);
    out.push({ name: p[0], expected: e, actual: a });
  }
  return out;
}
