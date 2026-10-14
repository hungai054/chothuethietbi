import { BOOKING_STATUS_LABEL, type BookingStatus } from '@rentpro/core';

const TONE: Record<BookingStatus, string> = {
  QUOTE: 'bg-slate-100 text-slate-700', HOLD: 'bg-amber-100 text-amber-800', CONFIRMED: 'bg-blue-100 text-blue-800',
  ACTIVE: 'bg-green-100 text-green-800', RETURNED: 'bg-teal-100 text-teal-800', CLOSED: 'bg-slate-200 text-slate-600', CANCELLED: 'bg-red-100 text-red-700',
};

export function StatusBadge({ status }: { status: BookingStatus }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONE[status]}`}>{BOOKING_STATUS_LABEL[status]}</span>;
}
