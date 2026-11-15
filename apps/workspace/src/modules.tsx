import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Ban, Boxes, ClipboardCheck, House, Package, PackageX, ShieldAlert, TrendingDown, Undo2 } from 'lucide-react';
import type { StaffRole } from './session.tsx';
import { ExternalCancellationsScreen } from './screens/admin/ExternalCancellationsScreen.tsx';
import { OrderCancellationsScreen } from './screens/admin/OrderCancellationsScreen.tsx';
import { RefundsScreen } from './screens/admin/RefundsScreen.tsx';
import { HomeScreen } from './screens/HomeScreen.tsx';
import { LowStockScreen } from './screens/pharmacy/LowStockScreen.tsx';
import { OrderScreen } from './screens/pharmacy/OrderScreen.tsx';
import { OrdersScreen } from './screens/pharmacy/OrdersScreen.tsx';
import { RxQueueScreen } from './screens/pharmacy/RxQueueScreen.tsx';
import { QualityScreen } from './screens/pharmacy/QualityScreen.tsx';
import { RxReviewScreen } from './screens/pharmacy/RxReviewScreen.tsx';
import { StockScreen } from './screens/pharmacy/StockScreen.tsx';

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
    path: '/pharmacy/orders', roles: ['pharmacy'], element: <OrdersScreen />,
    nav: { label: 'Orders', icon: Package, section: 'Pharmacy' },
  },
  { path: '/pharmacy/orders/:orderId', roles: ['pharmacy'], element: <OrderScreen /> },
  {
    path: '/pharmacy/prescriptions', roles: ['pharmacy'], element: <RxQueueScreen />,
    nav: { label: 'Prescription review', icon: ClipboardCheck, section: 'Pharmacy' },
  },
  { path: '/pharmacy/prescriptions/:orderId', roles: ['pharmacy'], element: <RxReviewScreen /> },
  { path: '/pharmacy/stock', roles: ['pharmacy'], element: <StockScreen />, nav: { label: 'Stock', icon: Boxes, section: 'Pharmacy' } },
  {
    path: '/pharmacy/low-stock', roles: ['pharmacy'], element: <LowStockScreen />,
    nav: { label: 'Low stock', icon: TrendingDown, section: 'Pharmacy' },
  },
  {
    path: '/pharmacy/quality', roles: ['pharmacy'], element: <QualityScreen />,
    nav: { label: 'Quality', icon: ShieldAlert, section: 'Pharmacy' },
  },
  {
    path: '/admin/order-cancellations', roles: ['admin'], element: <OrderCancellationsScreen />,
    nav: { label: 'Order cancellations', icon: PackageX, section: 'Admin' },
  },
  {
    path: '/admin/refunds', roles: ['admin'], element: <RefundsScreen />,
    nav: { label: 'Refunds needing attention', icon: Undo2, section: 'Admin' },
  },
  {
    path: '/admin/external-cancellations', roles: ['admin'], element: <ExternalCancellationsScreen />,
    nav: { label: 'External cancellations', icon: Ban, section: 'Admin' },
  },
];

export function pagesFor(role: StaffRole): WorkspacePage[] {
  return PAGES.filter((p) => p.roles.includes(role));
}
