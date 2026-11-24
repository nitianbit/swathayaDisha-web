import { useEffect, useMemo, useRef } from 'react';
import { createHashRouter, Outlet, RouterProvider, useLocation } from 'react-router';
import { Empty, LanguageScope, Loading } from '@jansetu/ui';
import { Shell } from './Shell.tsx';
import { pagesFor } from './modules.tsx';
import { useSession } from './session.tsx';
import { LoginScreen } from './screens/LoginScreen.tsx';
import type { StaffUser } from './session.tsx';

/** Moves focus to the page title after navigation so screen readers announce the new page. */
function FocusOnNavigate() {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    document.getElementById('page-title')?.focus();
  }, [pathname]);
  return null;
}

function routerFor(user: StaffUser) {
  return createHashRouter([{
    element: <Shell><FocusOnNavigate /><Outlet /></Shell>,
    children: [
      ...pagesFor(user).map((p) => ({ path: p.path, element: p.element })),
      { path: '*', element: <Empty title="Page not found">This page does not exist or is not available to your account.</Empty> },
    ],
  }]);
}

/** A fresh router per sign-in; it starts at the current hash, so a deep link survives signing in again. */
function SignedIn({ user }: { user: StaffUser }) {
  const router = useMemo(() => routerFor(user), [user]);
  return <RouterProvider router={router} />;
}

export function App() {
  const { state } = useSession();
  // D4: a reload resumes the cookie session before deciding to show the sign-in screen.
  if (state.status === 'restoring') return <main className="login"><Loading label="Signing you in…" /></main>;
  if (state.status !== 'signed_in') return <LanguageScope><LoginScreen notice={state.notice} /></LanguageScope>;
  return <SignedIn user={state.user} />;
}
