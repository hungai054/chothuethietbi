export const BOOKING_STATUSES = ['QUOTE', 'HOLD', 'CONFIRMED', 'ACTIVE', 'RETURNED', 'CLOSED', 'CANCELLED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  QUOTE: 'Báo giá', HOLD: 'Giữ chỗ', CONFIRMED: 'Đã xác nhận', ACTIVE: 'Đang thuê', RETURNED: 'Đã trả', CLOSED: 'Đã đóng', CANCELLED: 'Đã hủy',
};

/** Trạng thái đơn mà thiết bị đang bị chiếm lịch. QUOTE chưa chiếm; RETURNED/CLOSED/CANCELLED đã trả lịch. */
export const HOLDS_INVENTORY: ReadonlySet<BookingStatus> = new Set<BookingStatus>(['HOLD', 'CONFIRMED', 'ACTIVE']);

const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  QUOTE: ['HOLD', 'CONFIRMED', 'CANCELLED'],
  HOLD: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['RETURNED'],
  RETURNED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

export class InvalidBookingTransitionError extends Error {
  constructor(public readonly from: BookingStatus, public readonly to: BookingStatus) {
    super(`Không thể chuyển đơn từ "${BOOKING_STATUS_LABEL[from]}" sang "${BOOKING_STATUS_LABEL[to]}".`);
    this.name = 'InvalidBookingTransitionError';
  }
}

export const canBookingTransition = (from: BookingStatus, to: BookingStatus) => TRANSITIONS[from].includes(to);
export const nextBookingStatuses = (from: BookingStatus): readonly BookingStatus[] => TRANSITIONS[from];

export function assertBookingTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canBookingTransition(from, to)) throw new InvalidBookingTransitionError(from, to);
}

/** Chỉ đơn chưa giao mới đổi được lịch (dời, đổi thiết bị). Đơn đang thuê chỉ gia hạn hoặc trả sớm. */
export const canReschedule = (s: BookingStatus) => s === 'QUOTE' || s === 'HOLD' || s === 'CONFIRMED';
export const canExtend = (s: BookingStatus) => s === 'HOLD' || s === 'CONFIRMED' || s === 'ACTIVE';
