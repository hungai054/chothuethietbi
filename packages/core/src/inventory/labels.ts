import bwipjs from 'bwip-js/node';

export interface LabelItem { barcode: string; name: string; subtitle?: string }
export interface LabelOptions {
  /** Khổ tem (mm). Mặc định 50x30. */
  widthMm: number;
  heightMm: number;
  /** Số tem trên một hàng của tờ in. */
  columns: number;
  showQr: boolean;
}

export const DEFAULT_LABEL: LabelOptions = { widthMm: 50, heightMm: 30, columns: 3, showQr: true };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function validateLabelOptions(o: LabelOptions): string | null {
  if (!(o.widthMm >= 20 && o.widthMm <= 150) || !(o.heightMm >= 15 && o.heightMm <= 100)) return 'Khổ tem phải từ 20x15 đến 150x100 mm.';
  if (!Number.isInteger(o.columns) || o.columns < 1 || o.columns > 8) return 'Số cột phải từ 1 đến 8.';
  return null;
}

/** Trang HTML in được (Ctrl+P): mỗi tem gồm Code128, QR (tuỳ chọn) và tên. SVG nhúng nên không cần tải thêm. */
export function renderLabelSheet(items: LabelItem[], opts: LabelOptions = DEFAULT_LABEL): string {
  const bad = validateLabelOptions(opts);
  if (bad) throw new Error(bad);
  const cells = items.map((it) => {
    const code = bwipjs.toSVG({ bcid: 'code128', text: it.barcode, scale: 2, height: Math.max(6, opts.heightMm / 4), includetext: true, textxalign: 'center' });
    const qr = opts.showQr ? bwipjs.toSVG({ bcid: 'qrcode', text: it.barcode, scale: 2 }) : '';
    return `<div class="label"><div class="name">${esc(it.name)}</div>${it.subtitle ? `<div class="sub">${esc(it.subtitle)}</div>` : ''}<div class="row"><div class="bar">${code}</div>${qr ? `<div class="qr">${qr}</div>` : ''}</div></div>`;
  });
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>In tem</title><style>
@page{margin:6mm}body{margin:0;font-family:Arial,sans-serif}
.sheet{display:grid;grid-template-columns:repeat(${opts.columns},${opts.widthMm}mm);gap:2mm}
.label{box-sizing:border-box;width:${opts.widthMm}mm;height:${opts.heightMm}mm;border:.2mm dashed #999;padding:1.5mm;overflow:hidden;page-break-inside:avoid}
.name{font-size:8pt;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sub{font-size:6pt;color:#444}
.row{display:flex;align-items:center;gap:1mm;height:calc(100% - 9mm)}.bar{flex:1;min-width:0}.bar svg{width:100%;height:100%}.qr{width:${Math.min(opts.heightMm - 8, 18)}mm}.qr svg{width:100%;height:auto}
</style></head><body><div class="sheet">${cells.join('')}</div></body></html>`;
}
