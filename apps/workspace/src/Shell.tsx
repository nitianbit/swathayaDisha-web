import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { LogOut } from 'lucide-react';
import { Button, LanguageScope, LanguageSwitcher, useLanguage } from '@jansetu/ui';
import { pagesFor } from './modules.tsx';
import { useSession, useStaff } from './session.tsx';
import { DoctorPresenceProvider } from './screens/doctor/presence.tsx';

export function Shell({ children }: { children: ReactNode }) {
  const user = useStaff();
  const { signOut } = useSession();
  useLanguage(); // the navigation follows a language change; the page itself is mounted again (LanguageScope)
  const nav = pagesFor(user).filter((p) => p.nav);
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
            <div className="ws-user-role">
              {user.partner ? `${user.roleLabel} · ${user.partner.partner.name}`
                : user.doctor?.specialization ? `${user.roleLabel} · ${user.doctor.specialization}` : user.roleLabel}
            </div>
          </div>
          <LanguageSwitcher />
          {/* A deliberate sign-out starts the next person at Home; an expired session keeps its page to resume. */}
          <Button variant="ghost" onClick={() => { window.history.replaceState(null, '', '#/'); signOut(); }}>
            <LogOut size={18} aria-hidden="true" /> Sign out
          </Button>
        </div>
      </aside>
      {/* WQ4: a doctor's "available now" (and its heartbeat) lives as long as the signed-in shell, across pages. */}
      <main id="main" className="ws-main">{user.role === 'specialist'
        ? <DoctorPresenceProvider key={user.id}><LanguageScope>{children}</LanguageScope></DoctorPresenceProvider>
        : <LanguageScope>{children}</LanguageScope>}</main>
    </div>
  );
}
