import { Link } from 'react-router';
import { Empty } from '@jansetu/ui';
import { pagesFor } from '../modules.tsx';
import { PageHeading } from '../PageHeading.tsx';
import { useStaff } from '../session.tsx';

export function HomeScreen() {
  const user = useStaff();
  const pages = pagesFor(user.role).filter((p) => p.nav && p.path !== '/');
  return (
    <>
      <PageHeading title={`Welcome, ${user.name}`}>What would you like to do?</PageHeading>
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
