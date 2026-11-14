import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ClipboardCheck, House } from 'lucide-react';
import type { StaffRole } from './session.tsx';
import { HomeScreen } from './screens/HomeScreen.tsx';
import { RxQueueScreen } from './screens/pharmacy/RxQueueScreen.tsx';
import { RxReviewScreen } from './screens/pharmacy/RxReviewScreen.tsx';

/**
 * Every workspace page is declared here with the roles that may open it. A path not listed here does not exist, and
 * a listed path is reachable only by its roles (deny by default). This only shapes the UI: the backend enforces access.
 */
export interface WorkspacePage {
  path: string;
  roles: readonly StaffRole[];
  element: ReactNode;
  /** Present for pages shown in the side navigation. */
  nav?: { label: string; icon: LucideIcon; section: string };
}

export const PAGES: readonly WorkspacePage[] = [
  { path: '/', roles: ['admin', 'pharmacy'], element: <HomeScreen />, nav: { label: 'Home', icon: House, section: '' } },
  {
    path: '/pharmacy/prescriptions', roles: ['pharmacy'], element: <RxQueueScreen />,
    nav: { label: 'Prescription review', icon: ClipboardCheck, section: 'Pharmacy' },
  },
  { path: '/pharmacy/prescriptions/:orderId', roles: ['pharmacy'], element: <RxReviewScreen /> },
];

export function pagesFor(role: StaffRole): WorkspacePage[] {
  return PAGES.filter((p) => p.roles.includes(role));
}
