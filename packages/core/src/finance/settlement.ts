/**
 * Quyết toán một đơn thuê. Mọi khoản tiền là số nguyên VND, lấy từ sổ cái (payment, booking_fee), không lưu số dư.
 *
 *  Phải thu   = tiền thuê (đã chốt) + các khoản phí (trễ, hư hỏng, mất…)
 *  Đã nhận    = thu tiền thuê + thu phí + tiền cọc;  Đã trả lại = hoàn tiền;  Bỏ qua = xóa nợ có lý do
 *  Cọc được khấu trừ trước, phần cọc dư mới được hoàn. Còn thiếu thì khách phải trả thêm.
 */

export type PaymentKind = 'RENT' | 'DEPOSIT' | 'FEE' | 'REFUND' | 'WRITE_OFF';
export const PAYMENT_KINDS: readonly PaymentKind[] = ['RENT', 'DEPOSIT', 'FEE', 'REFUND', 'WRITE_OFF'];
export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = { RENT: 'Tiền thuê', DEPOSIT: 'Tiền cọc', FEE: 'Phí phát sinh', REFUND: 'Hoàn tiền', WRITE_OFF: 'Xóa nợ' };

export const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'E_WALLET', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = { CASH: 'Tiền mặt', BANK_TRANSFER: 'Chuyển khoản', CARD: 'Thẻ', E_WALLET: 'Ví điện tử', OTHER: 'Khác' };

export const FEE_KINDS = ['LATE', 'DAMAGE', 'LOSS', 'OTHER'] as const;
export type FeeKind = (typeof FEE_KINDS)[number];
export const FEE_KIND_LABEL: Record<FeeKind, string> = { LATE: 'Phí trễ hạn', DAMAGE: 'Phí hư hỏng', LOSS: 'Bồi thường mất', OTHER: 'Phí khác' };

export interface SettlementInput {
  rentTotal: number;
  /** Tổng các khoản phí còn hiệu lực */
  fees: number;
  /** Tổng theo loại của các khoản thanh toán còn hiệu lực */
  paid: Partial<Record<PaymentKind, number>>;
}

export interface Settlement {
  charges: number;
  rentTotal: number;
  fees: number;
  received: number;
  /** Tiền thuê + phí đang giữ (đã trừ phần hoàn vượt cọc) */
  collected: number;
  refunded: number;
  writtenOff: number;
  /** Cọc tiền mặt/chuyển khoản đang giữ (đã trừ phần hoàn) */
  depositHeld: number;
  /** Phần cọc được khấu trừ vào tiền phải thu */
  depositApplied: number;
  /** Khách còn phải trả thêm */
  balanceOwed: number;
  /** Cửa hàng còn phải hoàn cho khách (cọc dư hoặc thu thừa) */
  refundDue: number;
  settled: boolean;
}

const nn = (n: number | undefined) => n ?? 0;
const isInt = (n: number) => Number.isInteger(n) && n >= 0;

export function computeSettlement(i: SettlementInput): Settlement {
  for (const v of [i.rentTotal, i.fees, ...Object.values(i.paid).map(nn)]) if (!isInt(v)) throw new Error('Số tiền quyết toán không hợp lệ.');
  const charges = i.rentTotal + i.fees;
  const rent = nn(i.paid.RENT), fee = nn(i.paid.FEE), deposit = nn(i.paid.DEPOSIT), refunded = nn(i.paid.REFUND), writtenOff = nn(i.paid.WRITE_OFF);
  const received = rent + fee + deposit;
  const needed = charges - writtenOff; // số khách thực sự phải trả
  const balance = needed - (received - refunded);
  // Hoàn tiền được trừ vào cọc trước; chỉ khi hoàn nhiều hơn cọc mới đụng tới tiền thuê/phí đã thu.
  const overRefund = Math.max(0, refunded - deposit);
  const depositHeld = Math.max(0, deposit - refunded);
  const collected = Math.max(0, rent + fee - overRefund); // tiền thuê + phí đang giữ
  const depositApplied = Math.min(depositHeld, Math.max(0, needed - collected));
  return {
    charges, rentTotal: i.rentTotal, fees: i.fees, received, refunded, writtenOff, collected, depositHeld, depositApplied,
    balanceOwed: Math.max(0, balance), refundDue: Math.max(0, -balance), settled: balance === 0,
  };
}

export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'REFUNDED';
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = { UNPAID: 'Chưa thanh toán', PARTIAL: 'Thanh toán một phần', PAID: 'Đã thanh toán đủ', REFUNDED: 'Đã hoàn tiền' };

/** Trạng thái thu tiền: chỉ tính tiền thuê và phí (tiền cọc không phải doanh thu, trừ phần được khấu trừ). */
export function paymentStatus(s: Settlement): PaymentStatus {
  if (s.charges === 0 && s.refunded > 0) return 'REFUNDED';
  const covered = s.writtenOff + s.collected + s.depositApplied; // phần khoản phải thu đã được đáp ứng
  if (s.charges > 0 && covered >= s.charges) return 'PAID';
  return covered > 0 ? 'PARTIAL' : 'UNPAID';
}
