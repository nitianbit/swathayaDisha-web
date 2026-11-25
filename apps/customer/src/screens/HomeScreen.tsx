import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CalendarDays, FlaskConical, Pill, ReceiptText, Stethoscope, Users, Video, Wallet } from 'lucide-react';
import { customerApi } from '@jansetu/api';
import { Alert, formatRupees, Loading } from '@jansetu/ui';
import { PageHeading } from '../common.tsx';
import { t } from '../i18n/index.ts';
import { useCustomer, useSession } from '../session.tsx';
import { RecordsRequestsCard } from './records/RecordsScreen.tsx';

/** What a complete profile needs before booking for someone (the older app asked for the same). */
export const missingProfileFields = (p: { name?: string; email?: string; gender?: string; dateOfBirth?: string }) =>
  (['name', 'email', 'gender', 'dateOfBirth'] as const).filter((k) => !p[k]);

export function HomeScreen() {
  const { api } = useSession();
  const me = useCustomer();
  const customers = customerApi(api);
  const profile = useQuery({ queryKey: ['me', me.id], queryFn: () => customers.profile() });
  const wallet = useQuery({ queryKey: ['wallet', me.id], queryFn: () => customers.wallet(me.id) });

  if (profile.isPending) return <Loading />;
  const p = profile.data;
  const missing = p ? missingProfileFields(p) : [];
  return (
    <>
      <PageHeading title={p?.name ? t('home.hello', { name: p.name.split(' ')[0]! }) : t('home.helloAnon')} />
      {profile.isError && <Alert>{t('home.profileFailed')}</Alert>}
      {missing.length > 0 && (
        <Alert tone="warn">
          {t('home.completeProfile')} <Link to="/profile">{t('home.completeProfileLink')}</Link>
        </Alert>
      )}
      {/* WQ28: a doctor asks to see past records: Allow or Deny here. */}
      <RecordsRequestsCard />
      <ul className="tiles">
        <li><Link to="/consult" className="tile"><Video aria-hidden="true" /><span>{t('common.consultNow')}</span></Link></li>
        <li><Link to="/doctors" className="tile"><Stethoscope aria-hidden="true" /><span>{t('common.bookDoctor')}</span></Link></li>
        <li><Link to="/labs" className="tile"><FlaskConical aria-hidden="true" /><span>{t('common.labTests')}</span></Link></li>
        <li><Link to="/pharmacy" className="tile"><Pill aria-hidden="true" /><span>{t('common.orderMedicines')}</span></Link></li>
        <li><Link to="/bookings" className="tile"><CalendarDays aria-hidden="true" /><span>{t('common.myBookings')}</span></Link></li>
        <li>
          <Link to="/wallet" className="tile">
            <Wallet aria-hidden="true" />
            <span>{t('nav.wallet')}{wallet.data ? <strong className="tile-value">{formatRupees(wallet.data.balance)}</strong> : null}</span>
          </Link>
        </li>
        <li><Link to="/bills" className="tile"><ReceiptText aria-hidden="true" /><span>{t('home.bills')}</span></Link></li>
        <li><Link to="/profile/family" className="tile"><Users aria-hidden="true" /><span>{t('family.title')}</span></Link></li>
      </ul>
    </>
  );
}
