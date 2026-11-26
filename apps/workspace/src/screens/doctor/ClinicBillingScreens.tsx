import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE, doctorStanding, VERIFICATION_LABEL } from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { practiceKey } from './ClinicsScreen.tsx';
import { NotADoctor, useDoctor, useDoctorProfile, useOwnedClinic, type DoctorContext } from './doctor.tsx';
import { CatalogueScreen } from '../partner/CatalogueScreen.tsx';
import { InvoicesScreen } from '../partner/InvoicesScreen.tsx';
import { t } from '../../i18n/doctor/index.ts';

/**
 * WQ51: Doctor › Bills and Doctor › Services and prices. Both belong to the doctor's own clinic, whose workspace is a
 * partner session: the partner routes refuse a doctor's session (`requireOperationalPartner`: `userType` partner), and
 * the only way into a partner workspace is the workspace choice after a sign-in code (`POST /auth/partner/select` takes
 * the one-use ticket of that code). So (option b) the page says where they are in one line and starts that sign-in: it
 * signs out with the `toClinicWorkspace` notice, which opens the sign-in on "Lab or clinic staff".
 * WQ56 (r39): a verified, active doctor who owns one verified clinic bills it here (`/specialists/me/clinic`, the same
 * bill and catalogue screens as its workspace); the way through the clinic workspace stays for anyone else.
 */
export function DoctorBillsScreen() {
  return <ClinicPage kind="bills" />;
}

export function DoctorPricesScreen() {
  return <ClinicPage kind="prices" />;
}

type Page = 'bills' | 'prices';
/** WQ51b: where the clinic workspace opens after the sign-in (the sign-in resumes the address it was left on). */
const LANDING: Record<Page, string> = { bills: '#/partner/invoices', prices: '#/partner/catalogue' };

function ClinicPage({ kind }: { kind: Page }) {
  const d = useDoctor();
  if (!d) return <NotADoctor />;
  return <ClinicPageFor key={d.identity} d={d} page={kind} />;
}

function ClinicPageFor({ d, page }: { d: DoctorContext; page: Page }) {
  const { signOut } = useSession();
  // The same read as Doctor › Clinics (one cache): the doctor's own clinic, or null.
  const q = useQuery({ queryKey: practiceKey(d), queryFn: () => d.api.practice() });
  // WQ51b: a doctor who is not verified and active cannot use the clinic workspace (the server closes it): no button.
  const profile = useDoctorProfile(d);
  const active = profile.data ? doctorStanding(profile.data) === 'active' : null;
  const state = q.data?.partner.verification?.state ?? 'pending';
  // WQ56b: nothing is offered until it is known whether he bills here (never the sign-out first, then the bills).
  const own = useOwnedClinic(d.user.id, active === true);
  if (profile.isPending || (active && own.pending)) return <Loading label={t('clinics.loadingYourClinic')} />;
  if (active && own.owned) return page === 'bills' ? <InvoicesScreen /> : <CatalogueScreen />;
  return (
    <>
      <PageHeading title={t(`clinicPage.${page}.title`)} />
      {q.isPending ? <Loading label={t('clinics.loadingYourClinic')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : !q.data ? (
          <Empty title={t('clinicPage.noClinic.title')}>
            {t('clinicPage.noClinic.body')} <Link to="/doctor/clinics">{t('clinicPage.noClinic.create')}</Link>
          </Empty>
        ) : (
          <section className="ws-section stack">
            <p>
              <strong>{q.data.partner.name}</strong>{' '}
              <Badge tone={state === 'verified' ? 'ok' : 'warn'}>{VERIFICATION_LABEL[state] ?? state}</Badge>
            </p>
            {state === 'suspended' ? <Alert tone="warn">{t('clinics.suspended')}</Alert>
              : state !== 'verified' && <Alert tone="warn">{t('clinicPage.notVerified')}</Alert>}
            <p>{t(`clinicPage.${page}.where`, { name: q.data.partner.name })}</p>
            {active === false ? <Alert tone="warn">{CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE}</Alert>
              : active && (
                <div className="ws-actions">
                  {/* As Shell's sign-out: the address is set first, so the clinic workspace opens on this page's twin. */}
                  <Button onClick={() => { window.history.replaceState(null, '', LANDING[page]); signOut('toClinicWorkspace'); }}>{t('clinicPage.open')}</Button>
                </div>
              )}
          </section>
        )}
    </>
  );
}
