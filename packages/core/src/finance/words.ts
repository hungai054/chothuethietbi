const DIGIT = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const SCALE = ['', 'nghìn', 'triệu', 'tỷ'];

function group(n: number, needZeroHundred: boolean): string {
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), u = n % 10;
  const p: string[] = [];
  if (h > 0 || needZeroHundred) p.push(`${DIGIT[h]} trăm`);
  if (t > 1) {
    p.push(`${DIGIT[t]} mươi`);
    if (u === 1) p.push('mốt');
    else if (u === 5) p.push('lăm');
    else if (u > 0) p.push(DIGIT[u]!);
  } else if (t === 1) {
    p.push('mười');
    if (u === 5) p.push('lăm');
    else if (u > 0) p.push(DIGIT[u]!);
  } else if (u > 0) {
    if (h > 0 || needZeroHundred) p.push('linh');
    p.push(DIGIT[u]!);
  }
  return p.join(' ');
}

/** Số tiền bằng chữ cho hợp đồng, VD 1.250.000 → "Một triệu hai trăm năm mươi nghìn đồng". */
export function vndInWords(amount: number): string {
  if (!Number.isInteger(amount) || amount < 0 || amount >= 1e15) throw new Error('Số tiền ngoài phạm vi đọc bằng chữ.');
  if (amount === 0) return 'Không đồng';
  // tách theo nhóm 3 chữ số từ phải sang; "tỷ" lặp cho số rất lớn
  const groups: number[] = [];
  let n = amount;
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]!;
    if (g === 0) continue;
    const higherNonZero = groups.slice(i + 1).some((x) => x > 0);
    const text = group(g, higherNonZero && g < 100);
    const scale = i % 4 === 3 ? 'tỷ' : SCALE[i % 4]!;
    parts.push(scale && i > 0 ? `${text} ${scale}`.trim() : text);
  }
  const s = parts.join(' ').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1) + ' đồng';
}
