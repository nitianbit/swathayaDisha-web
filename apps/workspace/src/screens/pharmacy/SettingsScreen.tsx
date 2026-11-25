import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pharmacyProfileApi, REGISTRATION_NUMBER_PATTERN } from '@jansetu/api';
import { Alert, Button, ErrorState, Loading, shared, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { PHARMACY_PROFILE_KEY } from './RxReviewScreen.tsx';
import { t } from '../../i18n/pharmacy/index.ts';

/** P9: the pharmacy's registered pharmacist, recorded on every prescription decision (one-button approval). */
export function SettingsScreen() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: PHARMACY_PROFILE_KEY, queryFn: () => pharmacyProfileApi(api).me() });
  const [name, setName] = useState('');
  const [registration, setRegistration] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const p = profile.data?.pharmacist;
    if (p) { setName(p.name); setRegistration(p.registrationNumber); }
  }, [profile.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = t('settings.enterThePharmacistSFull');
    if (!REGISTRATION_NUMBER_PATTERN.test(registration.trim())) errs.registration = t('settings.enterThePharmacistRegistrationNumber');
    setErrors(errs); setSaved(false); setError(null);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await pharmacyProfileApi(api).setPharmacist({ name: name.trim(), registrationNumber: registration.trim() });
      await queryClient.invalidateQueries({ queryKey: PHARMACY_PROFILE_KEY });
      setSaved(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeading title={t('settings.settings')}>{t('settings.whoApprovesPrescriptionsForThis')}</PageHeading>
      {profile.isPending ? <Loading /> : profile.isError ? <ErrorState message={messageOf(profile.error)} onRetry={() => void profile.refetch()} /> : (
        <section className="ws-section" aria-labelledby="pharmacist-h">
          <h2 id="pharmacist-h">{t('common.pharmacist')}</h2>
          <p className="ws-muted">{t('settings.everyPrescriptionApprovalOrRejection')}</p>
          <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
            <div className="rx-form-row">
              <TextField label={t('settings.pharmacistName')} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={120} />
              <TextField label={t('settings.registrationNumber')} value={registration} onChange={(e) => setRegistration(e.target.value)} error={errors.registration} maxLength={60} />
            </div>
            {saved && <Alert tone="ok">{t('settings.saved')}</Alert>}
            {error && <Alert>{error}</Alert>}
            <Button type="submit" busy={busy}>{shared('action.save')}</Button>
          </form>
        </section>
      )}
    </>
  );
}
