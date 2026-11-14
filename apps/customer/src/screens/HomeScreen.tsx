import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CalendarDays, Users, Wallet } from 'lucide-react';
import { customerApi } from '@jansetu/api';
import { Alert, formatRupees, Loading } from '@jansetu/ui';
import { PageHeading } from '../common.tsx';
import { useCustomer, useSession } from '../session.tsx';

/** What a complete profile needs before booking for someone (the older app asked for the same). */
export const missingProfileFields = (p: { name?: string; email?: string; gender?: string; dateOfBirth?: string }) =>
  (['name', 'email', 'gender', 'dateOfBirth'] as const).filter((k) => !p[k]);

export function HomeScreen() {
  const { api } = useSession();
  const me = useCustomer();
  const customers = customerApi(api);
  const profile = useQuery({ queryKey: ['me'], queryFn: () => customers.profile() });
  const wallet = useQuery({ queryKey: ['wallet', me.id], queryFn: () => customers.wallet(me.id) });

  if (profile.isPending) return <Loading />;
  const p = profile.data;
  const missing = p ? missingProfileFields(p) : [];
  return (
    <>
      <PageHeading title={p?.name ? `Hello, ${p.name.split(' ')[0]}` : 'Hello'} />
      {profile.isError && <Alert>Your profile could not be loaded. Pull down or try again later.</Alert>}
      {missing.length > 0 && (
        <Alert tone="warn">
          Complete your profile so we can book for you. <Link to="/profile">Complete profile</Link>
        </Alert>
      )}
      <ul className="tiles">
        <li><Link to="/bookings" className="tile"><CalendarDays aria-hidden="true" /><span>My bookings</span></Link></li>
        <li>
          <Link to="/wallet" className="tile">
            <Wallet aria-hidden="true" />
            <span>Wallet{wallet.data ? <strong className="tile-value">{formatRupees(wallet.data.balance)}</strong> : null}</span>
          </Link>
        </li>
        <li><Link to="/profile/family" className="tile"><Users aria-hidden="true" /><span>Family members</span></Link></li>
      </ul>
    </>
  );
}
