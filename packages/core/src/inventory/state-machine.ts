export const UNIT_STATUSES = ['AVAILABLE', 'RESERVED', 'RENTED', 'INSPECTING', 'MAINTENANCE', 'RETIRED', 'LOST'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  AVAILABLE: 'Rảnh', RESERVED: 'Đã giữ chỗ', RENTED: 'Đang thuê', INSPECTING: 'Đang kiểm tra',
  MAINTENANCE: 'Bảo trì', RETIRED: 'Đã thanh lý', LOST: 'Mất',
};

/** Chuyển trạng thái hợp lệ. RETIRED là điểm cuối. */
const TRANSITIONS: Record<UnitStatus, readonly UnitStatus[]> = {
  AVAILABLE: ['RESERVED', 'MAINTENANCE', 'RETIRED', 'LOST'],
  RESERVED: ['RENTED', 'AVAILABLE'],
  RENTED: ['INSPECTING', 'LOST'],
  INSPECTING: ['AVAILABLE', 'MAINTENANCE', 'RETIRED', 'LOST'],
  MAINTENANCE: ['AVAILABLE', 'RETIRED', 'LOST'],
  LOST: ['AVAILABLE', 'RETIRED'],
  RETIRED: [],
};

/** Chỉ hệ thống (đặt lịch, giao/nhận) được tự đặt các trạng thái này; người dùng không chọn tay. */
export const SYSTEM_ONLY: ReadonlySet<UnitStatus> = new Set(['RESERVED', 'RENTED', 'INSPECTING']);

export class InvalidTransitionError extends Error {
  constructor(public readonly from: UnitStatus, public readonly to: UnitStatus) {
    super(`Không thể chuyển thiết bị từ "${UNIT_STATUS_LABEL[from]}" sang "${UNIT_STATUS_LABEL[to]}".`);
    this.name = 'InvalidTransitionError';
  }
}

export const canTransition = (from: UnitStatus, to: UnitStatus) => TRANSITIONS[from].includes(to);
export const nextStatuses = (from: UnitStatus): readonly UnitStatus[] => TRANSITIONS[from];

export function assertTransition(from: UnitStatus, to: UnitStatus, opts: { system?: boolean } = {}): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  if (!opts.system && SYSTEM_ONLY.has(to)) {
    throw new Error(`Trạng thái "${UNIT_STATUS_LABEL[to]}" do hệ thống đặt lịch tự cập nhật, không đổi tay được.`);
  }
}
