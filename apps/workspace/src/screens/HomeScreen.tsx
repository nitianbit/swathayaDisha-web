import { Link } from 'react-router';
import { Alert, Empty } from '@jansetu/ui';
import { pagesFor } from '../modules.tsx';
import { PageHeading } from '../PageHeading.tsx';
import { useStaff } from '../session.tsx';
import { DoctorHome } from './doctor/DoctorHome.tsx';

export function HomeScreen() {
  const user = useStaff();
  const pages = pagesFor(user).filter((p) => p.nav && p.path !== '/');
  return (
    <>
      <PageHeading title={`Welcome, ${user.name}`}>
        {user.partner ? `${user.partner.partner.name} · What would you like to do?` : 'What would you like to do?'}
      </PageHeading>
      {user.partner && user.partner.partner.verification !== 'verified' && (
        <Alert tone="warn">
          {user.partner.partner.verification === 'suspended'
            ? 'This account is suspended. Contact Jansetu support.'
            : `${user.partner.partner.name} is waiting for verification by Jansetu. The workspace opens once it is verified.`}
        </Alert>
      )}
      {user.role === 'specialist' && <DoctorHome />}
      {pages.length === 0 ? (
        <Empty title="Nothing here yet">Tools for your role are being added.</Empty>
      ) : (
        <ul className="home-links">
          {pages.map((p) => {
            const Icon = p.nav!.icon;
            return (
              <li key={p.path}>
                <Link to={p.path} className="home-link">
                  <Icon size={22} aria-hidden="true" />
                  <span>{p.nav!.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
