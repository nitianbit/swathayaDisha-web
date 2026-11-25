import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { VERIFICATION_LABEL } from '@jansetu/api';
import { Alert, Badge, Button, Empty, ErrorState, Loading } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { practiceKey } from './ClinicsScreen.tsx';
import { NotADoctor, useDoctor, type DoctorContext } from './doctor.tsx';
import { t } from '../../i18n/doctor/index.ts';

/**
 * WQ51: Doctor › Bills and Doctor › Services and prices. Both belong to the doctor's own clinic, whose workspace is a
 * partner session: the partner routes refuse a doctor's session (`requireOperationalPartner`: `userType` partner), and
 * the only way into a partner workspace is the workspace choice after a sign-in code (`POST /auth/partner/select` takes
 * the one-use ticket of that code). So (option b) the page says where they are in one line and starts that sign-in: it
 * signs out with the `toClinicWorkspace` notice, which opens the sign-in on "Lab or clinic staff".
 */
export function DoctorBillsScreen() {
  return <ClinicPage kind="bills" />;
}

export function DoctorPricesScreen() {
  return <ClinicPage kind="prices" />;
}

type Page = 'bills' | 'prices';

function ClinicPage({ kind }: { kind: Page }) {
  const d = useDoctor();
  if (!d) return <NotADoctor />;
  return <ClinicPageFor key={d.identity} d={d} page={kind} />;
}

function ClinicPageFor({ d, page }: { d: DoctorContext; page: Page }) {
  const { signOut } = useSession();
  // The same read as Doctor › Clinics (one cache): the doctor's own clinic, or null.
  const q = useQuery({ queryKey: practiceKey(d), queryFn: () => d.api.practice() });
  const state = q.data?.partner.verification?.state ?? 'pending';
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
            {state !== 'verified' && <Alert tone="warn">{t('clinicPage.notVerified')}</Alert>}
            <p>{t(`clinicPage.${page}.where`, { name: q.data.partner.name })}</p>
            <div className="ws-actions"><Button onClick={() => signOut('toClinicWorkspace')}>{t('clinicPage.open')}</Button></div>
          </section>
        )}
    </>
  );
}
