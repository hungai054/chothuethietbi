import type { ReactNode } from 'react';
import { requireAccess } from '@/lib/session';

export default async function MaintenanceLayout({ children }: { children: ReactNode }) {
  await requireAccess('maintenance', 'maintenance.view');
  return children;
}
