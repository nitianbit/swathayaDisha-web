import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { House, LogOut, Menu, X } from 'lucide-react';
import { Button, LanguageScope, LanguageSwitcher, useLanguage } from '@jansetu/ui';
import { navLabelKey, pagesFor } from './modules.tsx';
import { t } from './i18n/shell/index.ts';
import { useSession, useStaff } from './session.tsx';
import { DoctorPresenceProvider } from './screens/doctor/presence.tsx';

/** The brand stays in Latin letters in every language (docs/I18N_PLAN.md §5.2). */
export const BRAND = 'Jansetu';

export function Shell({ children }: { children: ReactNode }) {
  const user = useStaff();
  const { signOut } = useSession();
  useLanguage(); // the navigation follows a language change; the page itself is mounted again (LanguageScope)
  const nav = pagesFor(user).filter((p) => p.nav);
  const sections = [...new Set(nav.map((p) => p.nav!.sectionKey))];
  // WQ54: on a phone the menu sits behind one "More" button (the page comes first); a tablet and a desktop show it always.
  // WQ54b: it closes on every page change (a link in it, Back, or a link on the page), and Home stays in the phone's header.
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname, search } = useLocation();
  useEffect(() => setMenuOpen(false), [pathname, search]);

  return (
    <div className="ws">
      <a className="ws-skip" href="#main">{t('shell.skip')}</a>
      <aside className="ws-side">
        <div className="ws-brand">{BRAND} <span>{t('shell.workspace')}</span></div>
        <div className="ws-phone-bar">
          {/* WQ54c: icon buttons on one row; their words for screen readers. */}
          <Link className="ws-phone-home" to="/"><House size={24} aria-hidden="true" /><span className="j-sr-only">{t('nav.home')}</span></Link>
          <button type="button" className="ws-more" aria-expanded={menuOpen} aria-controls="ws-menu" onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? <X size={24} aria-hidden="true" /> : <Menu size={24} aria-hidden="true" />}
            <span className="j-sr-only">{menuOpen ? t('shell.close') : t('shell.more')}</span>
          </button>
        </div>
        <div id="ws-menu" className={menuOpen ? 'ws-menu ws-menu--open' : 'ws-menu'}>
        <nav aria-label={t('shell.nav')}>
          {sections.map((section) => (
            <div key={section || 'top'} className="ws-nav-group">
              {section && <div className="ws-nav-section">{t(section)}</div>}
              {nav.filter((p) => p.nav!.sectionKey === section).map((p) => {
                const Icon = p.nav!.icon;
                return (
                  <NavLink key={p.path} to={p.path} end={p.path === '/'} className="ws-nav-link" onClick={() => setMenuOpen(false)}>
                    <Icon size={18} aria-hidden="true" />
                    {t(navLabelKey(p, user))}
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
            <LogOut size={18} aria-hidden="true" /> {t('shell.signOut')}
          </Button>
        </div>
        </div>
      </aside>
      {/* WQ4: a doctor's "available now" (and its heartbeat) lives as long as the signed-in shell, across pages. */}
      <main id="main" className="ws-main">{user.role === 'specialist'
        ? <DoctorPresenceProvider key={user.id}><LanguageScope>{children}</LanguageScope></DoctorPresenceProvider>
        : <LanguageScope>{children}</LanguageScope>}</main>
    </div>
  );
}
