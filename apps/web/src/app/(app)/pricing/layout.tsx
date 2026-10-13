import type { ReactNode } from 'react';
import { requireAccess } from '@/lib/session';

export default async function PricingLayout({ children }: { children: ReactNode }) {
  await requireAccess('pricing', 'pricing.view');
  return children;
}
