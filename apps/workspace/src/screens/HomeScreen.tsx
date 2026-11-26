import { Link } from 'react-router';
import { Alert, Empty } from '@jansetu/ui';
import { navLabelKey, pagesFor } from '../modules.tsx';
import { PageHeading } from '../PageHeading.tsx';
import { useStaff } from '../session.tsx';
import { t } from '../i18n/shell/index.ts';
import { DoctorHome } from './doctor/DoctorHome.tsx';
import { useFrontDesk } from './front/desk.tsx';
import { FrontDeskHome } from './front/home.tsx';

export function HomeScreen() {
  const user = useStaff();
  const pages = pagesFor(user).filter((p) => p.nav && p.path !== '/');
  const desk = useFrontDesk();
  return (
    <>
      <PageHeading title={t('home.welcome', { name: user.name })}>
        {user.partner ? t('home.questionAt', { partner: user.partner.partner.name }) : t('home.question')}
      </PageHeading>
      {user.partner && user.partner.partner.verification !== 'verified' && (
        <Alert tone="warn">
          {user.partner.partner.verification === 'suspended'
            ? t('home.suspended')
            : t('home.unverified', { partner: user.partner.partner.name })}
        </Alert>
      )}
      {/* WQ54 (P1) / WQ55 (P4): a pharmacy's and a lab member's home is its big buttons, today's register and to-dos; WQ56
          (P2) a doctor's is his dashboard. The menu stays for the long way. */}
      {user.role === 'specialist' ? <DoctorHome /> : desk ? <FrontDeskHome desk={desk} /> : pages.length === 0 ? (
        <Empty title={t('home.empty.title')}>{t('home.empty.body')}</Empty>
      ) : (
        <ul className="home-links">
          {pages.map((p) => {
            const Icon = p.nav!.icon;
            return (
              <li key={p.path}>
                <Link to={p.path} className="home-link">
                  <Icon size={22} aria-hidden="true" />
                  <span>{t(navLabelKey(p, user))}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
