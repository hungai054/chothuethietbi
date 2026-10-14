/**
 * Mã VietQR (chuẩn EMVCo/NAPAS 247) tự sinh, không gọi dịch vụ ngoài. Khách quét bằng ứng dụng ngân hàng,
 * số tiền và nội dung được điền sẵn. Nội dung chuyển khoản là số hợp đồng/đơn để đối soát.
 */

export class VietQrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VietQrError';
  }
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). Vector chuẩn: "123456789" → 29B1. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const tlv = (id: string, value: string) => {
  if (value.length > 99) throw new VietQrError('Giá trị quá dài cho mã QR.');
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
};

/** Bỏ dấu tiếng Việt và ký tự lạ: ngân hàng chỉ nhận chữ, số, khoảng trắng và gạch ngang trong nội dung. */
export function sanitizeMemo(raw: string, max = 50): string {
  return raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
}

export interface BankAccount { bin: string; account: string; accountName?: string }

export function validateBankAccount(b: BankAccount): string | null {
  if (!/^\d{6}$/.test(b.bin)) return 'Mã ngân hàng (BIN) gồm đúng 6 chữ số.';
  if (!/^\d{6,19}$/.test(b.account)) return 'Số tài khoản gồm 6 đến 19 chữ số.';
  if (b.accountName !== undefined && b.accountName.length > 60) return 'Tên chủ tài khoản tối đa 60 ký tự.';
  return null;
}

export interface VietQrInput extends BankAccount { amount?: number; memo?: string }

export function buildVietQrPayload(i: VietQrInput): string {
  const bad = validateBankAccount(i);
  if (bad) throw new VietQrError(bad);
  if (i.amount !== undefined && (!Number.isInteger(i.amount) || i.amount <= 0 || i.amount > 9_999_999_999_999)) throw new VietQrError('Số tiền phải là số nguyên dương.');
  const beneficiary = tlv('00', i.bin) + tlv('01', i.account);
  const merchant = tlv('00', 'A000000727') + tlv('01', beneficiary) + tlv('02', 'QRIBFTTA');
  const memo = i.memo ? sanitizeMemo(i.memo) : '';
  const body =
    tlv('00', '01') +
    tlv('01', i.amount ? '12' : '11') + // 12 = động (có số tiền), 11 = tĩnh
    tlv('38', merchant) +
    tlv('53', '704') +
    (i.amount ? tlv('54', String(i.amount)) : '') +
    tlv('58', 'VN') +
    (memo ? tlv('62', tlv('08', memo)) : '') +
    '6304';
  return body + crc16(body);
}

/** Tách TLV để kiểm tra/ghi nhật ký. Ném lỗi nếu độ dài không khớp. */
export function parseTlv(s: string): { id: string; value: string }[] {
  const out: { id: string; value: string }[] = [];
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || Number.isNaN(len) || i + 4 + len > s.length) throw new VietQrError('Mã QR sai định dạng.');
    out.push({ id, value: s.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}

export function verifyVietQr(payload: string): boolean {
  if (payload.length < 8 || payload.slice(-8, -4) !== '6304') return false;
  return crc16(payload.slice(0, -4)) === payload.slice(-4);
}

/** Một số ngân hàng phổ biến (mã BIN do NAPAS cấp). Người dùng vẫn nhập tay được nếu ngân hàng không có trong danh sách. */
export const BANKS: { bin: string; name: string }[] = [
  { bin: '970436', name: 'Vietcombank' }, { bin: '970415', name: 'VietinBank' }, { bin: '970418', name: 'BIDV' },
  { bin: '970405', name: 'Agribank' }, { bin: '970407', name: 'Techcombank' }, { bin: '970422', name: 'MB Bank' },
  { bin: '970416', name: 'ACB' }, { bin: '970432', name: 'VPBank' }, { bin: '970423', name: 'TPBank' },
  { bin: '970403', name: 'Sacombank' }, { bin: '970437', name: 'HDBank' }, { bin: '970441', name: 'VIB' },
  { bin: '970443', name: 'SHB' }, { bin: '970426', name: 'MSB' }, { bin: '970448', name: 'OCB' },
];
