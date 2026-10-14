import type { ReactNode } from 'react';
import { requireAccess } from '@/lib/session';

export default async function BookingsLayout({ children }: { children: ReactNode }) {
  await requireAccess('booking', 'booking.view');
  return children;
}
