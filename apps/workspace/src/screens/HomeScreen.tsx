import { Link } from 'react-router';
import { Alert, Empty } from '@jansetu/ui';
import { pagesFor } from '../modules.tsx';
import { PageHeading } from '../PageHeading.tsx';
import { useStaff } from '../session.tsx';
import { t } from '../i18n/shell/index.ts';
import { DoctorHome } from './doctor/DoctorHome.tsx';

export function HomeScreen() {
  const user = useStaff();
  const pages = pagesFor(user).filter((p) => p.nav && p.path !== '/');
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
      {user.role === 'specialist' && <DoctorHome />}
      {pages.length === 0 ? (
        <Empty title={t('home.empty.title')}>{t('home.empty.body')}</Empty>
      ) : (
        <ul className="home-links">
          {pages.map((p) => {
            const Icon = p.nav!.icon;
            return (
              <li key={p.path}>
                <Link to={p.path} className="home-link">
                  <Icon size={22} aria-hidden="true" />
                  <span>{t(p.nav!.labelKey)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
