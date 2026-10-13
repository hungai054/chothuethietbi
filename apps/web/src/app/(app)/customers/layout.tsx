import type { ReactNode } from 'react';
import { requireAccess } from '@/lib/session';

export default async function CustomersLayout({ children }: { children: ReactNode }) {
  await requireAccess('customers', 'customer.view');
  return children;
}
