import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { LogOut } from 'lucide-react';
import { Button } from '@jansetu/ui';
import { pagesFor } from './modules.tsx';
import { useSession, useStaff } from './session.tsx';

const ROLE_LABEL = { admin: 'Admin', pharmacy: 'Pharmacy' } as const;

export function Shell({ children }: { children: ReactNode }) {
  const user = useStaff();
  const { signOut } = useSession();
  const nav = pagesFor(user.role).filter((p) => p.nav);
  const sections = [...new Set(nav.map((p) => p.nav!.section))];

  return (
    <div className="ws">
      <a className="ws-skip" href="#main">Skip to content</a>
      <aside className="ws-side">
        <div className="ws-brand">Jansetu <span>Workspace</span></div>
        <nav aria-label="Main">
          {sections.map((section) => (
            <div key={section || 'top'} className="ws-nav-group">
              {section && <div className="ws-nav-section">{section}</div>}
              {nav.filter((p) => p.nav!.section === section).map((p) => {
                const Icon = p.nav!.icon;
                return (
                  <NavLink key={p.path} to={p.path} end={p.path === '/'} className="ws-nav-link">
                    <Icon size={18} aria-hidden="true" />
                    {p.nav!.label}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="ws-user">
          <div>
            <div className="ws-user-name">{user.name}</div>
            <div className="ws-user-role">{ROLE_LABEL[user.role]}</div>
          </div>
          {/* A deliberate sign-out starts the next person at Home; an expired session keeps its page to resume. */}
          <Button variant="ghost" onClick={() => { window.history.replaceState(null, '', '#/'); signOut(); }}>
            <LogOut size={18} aria-hidden="true" /> Sign out
          </Button>
        </div>
      </aside>
      <main id="main" className="ws-main">{children}</main>
    </div>
  );
}
