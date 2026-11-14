import { useEffect, useMemo, useRef } from 'react';
import { createHashRouter, NavLink, Outlet, RouterProvider, useLocation } from 'react-router';
import { CalendarDays, House, UserRound, Wallet } from 'lucide-react';
import { Empty } from '@jansetu/ui';
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

const TABS = [
  { to: '/', label: 'Home', icon: House },
  { to: '/bookings', label: 'Bookings', icon: CalendarDays },
  { to: '/wallet', label: 'Wallet', icon: Wallet },
  { to: '/profile', label: 'Profile', icon: UserRound },
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
  return (
    <div className="app">
      <a className="app-skip" href="#main">Skip to content</a>
      <main id="main" className="app-main"><FocusOnNavigate /><Outlet /></main>
      <nav className="app-tabs" aria-label="Main">
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'} className="app-tab">
            <Icon size={22} aria-hidden="true" />
            <span>{label}</span>
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
      { path: '/wallet', element: <WalletScreen /> },
      { path: '/profile', element: <ProfileScreen /> },
      { path: '/profile/family', element: <FamilyScreen /> },
      { path: '*', element: <Empty title="Page not found">This page does not exist.</Empty> },
    ],
  }]);
}

function SignedIn({ customer }: { customer: Customer }) {
  const r = useMemo(() => router(), [customer]);
  return <RouterProvider router={r} />;
}

export function App() {
  const { state } = useSession();
  if (state.status !== 'signed_in') return <LoginScreen notice={state.notice} />;
  return <SignedIn customer={state.customer} />;
}
