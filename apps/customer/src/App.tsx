import { useEffect, useMemo, useRef } from 'react';
import { createHashRouter, NavLink, Outlet, RouterProvider, useLocation } from 'react-router';
import { CalendarDays, House, Pill, UserRound, Wallet } from 'lucide-react';
import { Empty, LanguageScope, Loading, useLanguage } from '@jansetu/ui';
import { t } from './i18n/index.ts';
import { useSession, type Customer } from './session.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import { HomeScreen } from './screens/HomeScreen.tsx';
import { BookingsScreen } from './screens/BookingsScreen.tsx';
import { BookingScreen } from './screens/BookingScreen.tsx';
import { ExternalBookingScreen } from './screens/ExternalBookingScreen.tsx';
import { WalletScreen } from './screens/WalletScreen.tsx';
import { ProfileScreen } from './screens/ProfileScreen.tsx';
import { FamilyScreen } from './screens/FamilyScreen.tsx';
import { DoctorsScreen } from './screens/DoctorsScreen.tsx';
import { DoctorScreen } from './screens/DoctorScreen.tsx';
import { StoresScreen } from './screens/pharmacy/StoresScreen.tsx';
import { StoreScreen } from './screens/pharmacy/StoreScreen.tsx';
import { CartScreen } from './screens/pharmacy/CartScreen.tsx';
import { PharmacyOrdersScreen } from './screens/pharmacy/OrdersScreen.tsx';
import { PharmacyOrderScreen } from './screens/pharmacy/OrderScreen.tsx';
import { LabsScreen } from './screens/labs/LabsScreen.tsx';
import { LabScreen } from './screens/labs/LabScreen.tsx';
import { LabBookingScreen } from './screens/labs/LabBookingScreen.tsx';
import { ConsultScreen } from './screens/consult/ConsultScreen.tsx';
import { InstantRequestScreen } from './screens/consult/InstantRequestScreen.tsx';
import { BillsScreen } from './screens/bills/BillsScreen.tsx';
import { BillScreen } from './screens/bills/BillScreen.tsx';

const TABS = [
  { to: '/', words: 'nav.home', icon: House },
  { to: '/bookings', words: 'nav.bookings', icon: CalendarDays },
  { to: '/pharmacy', words: 'nav.medicines', icon: Pill },
  { to: '/wallet', words: 'nav.wallet', icon: Wallet },
  { to: '/profile', words: 'nav.profile', icon: UserRound },
] as const;

function FocusOnNavigate() {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.scrollTo(0, 0);
    document.getElementById('page-title')?.focus();
  }, [pathname]);
  return null;
}

function Layout() {
  useLanguage(); // the tab names follow a language change; the page itself is mounted again (LanguageScope)
  return (
    <div className="app">
      <a className="app-skip" href="#main">{t('nav.skip')}</a>
      <main id="main" className="app-main"><FocusOnNavigate /><LanguageScope><Outlet /></LanguageScope></main>
      <nav className="app-tabs" aria-label={t('nav.main')}>
        {TABS.map(({ to, words, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'} className="app-tab">
            <Icon size={22} aria-hidden="true" />
            <span>{t(words)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function router() {
  return createHashRouter([{
    element: <Layout />,
    children: [
      { path: '/', element: <HomeScreen /> },
      { path: '/bookings', element: <BookingsScreen /> },
      { path: '/bookings/:bookingId', element: <BookingScreen /> },
      { path: '/lab-bookings/:bookingId', element: <ExternalBookingScreen /> },
      { path: '/doctors', element: <DoctorsScreen /> },
      { path: '/doctors/:doctorId', element: <DoctorScreen /> },
      { path: '/labs', element: <LabsScreen /> },
      { path: '/labs/:partnerId', element: <LabScreen /> },
      { path: '/partner-lab-bookings/:bookingId', element: <LabBookingScreen /> },
      { path: '/consult', element: <ConsultScreen /> },
      { path: '/consult/requests/:requestId', element: <InstantRequestScreen /> },
      { path: '/bills', element: <BillsScreen /> },
      { path: '/bills/:invoiceId', element: <BillScreen /> },
      { path: '/pharmacy', element: <StoresScreen /> },
      { path: '/pharmacy/stores/:pharmacyId', element: <StoreScreen /> },
      { path: '/pharmacy/cart', element: <CartScreen /> },
      { path: '/pharmacy/orders', element: <PharmacyOrdersScreen /> },
      { path: '/pharmacy/orders/:orderId', element: <PharmacyOrderScreen /> },
      { path: '/wallet', element: <WalletScreen /> },
      { path: '/profile', element: <ProfileScreen /> },
      { path: '/profile/family', element: <FamilyScreen /> },
      { path: '*', element: <Empty title={t('app.notFound.title')}>{t('app.notFound.body')}</Empty> },
    ],
  }]);
}

function SignedIn({ customer }: { customer: Customer }) {
  const r = useMemo(() => router(), [customer]);
  return <RouterProvider router={r} />;
}

export function App() {
  const { state } = useSession();
  // D4: a reload resumes the cookie session before deciding to show the sign-in screen.
  if (state.status === 'restoring') return <main className="login"><Loading label={t('app.signingIn')} /></main>;
  if (state.status !== 'signed_in') return <LanguageScope><LoginScreen notice={state.notice} /></LanguageScope>;
  return <SignedIn customer={state.customer} />;
}
