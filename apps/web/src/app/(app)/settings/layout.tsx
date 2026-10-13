import type { ReactNode } from 'react';
import { requireAccess } from '@/lib/session';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  await requireAccess('pricing', 'settings.manage');
  return children;
}
