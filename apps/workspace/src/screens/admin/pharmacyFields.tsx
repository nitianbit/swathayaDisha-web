import {
  MAX_DRUG_LICENSE, MAX_EMAIL, MAX_GST_NUMBER, MAX_PHARMACY_NAME, MAX_PHARMACY_NICKNAME, MAX_PHARMACY_OWNER, type PharmacyForm,
} from '@jansetu/api';
import { TextField } from '@jansetu/ui';
import { t } from '../../i18n/admin/index.ts';

type Errors = Partial<Record<keyof PharmacyForm, string>>;
type Set = <K extends keyof PharmacyForm>(k: K, v: PharmacyForm[K]) => void;

/** The sign-in fields: the mobile number (required) and an optional email. */
export function SignInFields({ form, errors, set, disabled }: { form: PharmacyForm; errors: Errors; set: Set; disabled?: boolean }) {
  return (
    <div className="rx-form-row">
      <TextField label={t('pharmacy.mobileNumber')} inputMode="numeric" maxLength={10} value={form.phone} error={errors.phone} disabled={disabled} autoComplete="off"
        hint={t('pharmacyFields.phoneHint')}
        onChange={(e) => set('phone', e.target.value.replace(/\D/g, ''))} />
      <TextField label={t('pharmacyFields.email')} type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL} autoComplete="off"
        value={form.email} error={errors.email} disabled={disabled} hint={t('pharmacyFields.emailHint')}
        onChange={(e) => set('email', e.target.value)} />
    </div>
  );
}

/** Everything else an admin records about a pharmacy (`createPharmacySchema` / `updatePharmacySchema`). */
export function DetailFields({ form, errors, set, disabled }: { form: PharmacyForm; errors: Errors; set: Set; disabled?: boolean }) {
  const text = (k: Exclude<keyof PharmacyForm, 'pickupAvailable' | 'deliveryAvailable'>) => ({
    value: form[k], error: errors[k], disabled, autoComplete: 'off', onChange: (e: { target: { value: string } }) => set(k, e.target.value),
  });
  return (
    <>
      <div className="rx-form-row">
        <TextField label={t('pharmacyFields.name')} maxLength={MAX_PHARMACY_NAME} {...text('name')} />
        <TextField label={t('pharmacyFields.nickname')} maxLength={MAX_PHARMACY_NICKNAME} {...text('nickname')} />
        <TextField label={t('pharmacyFields.ownerName')} maxLength={MAX_PHARMACY_OWNER} {...text('ownerName')} />
      </div>
      <div className="rx-form-row">
        <TextField label={t('pharmacyFields.address')} {...text('address')} />
        <TextField label={t('pharmacyFields.city')} {...text('city')} />
        <TextField label={t('pharmacyFields.state')} {...text('state')} />
        <TextField label={t('pharmacyFields.pincode')} inputMode="numeric" maxLength={6} {...text('pincode')} />
      </div>
      <div className="rx-form-row">
        <TextField label={t('pharmacyFields.gstNumber')} maxLength={MAX_GST_NUMBER} {...text('gstNumber')} />
        <TextField label={t('pharmacyFields.drugLicenseNumber')} maxLength={MAX_DRUG_LICENSE} {...text('drugLicenseNumber')} />
      </div>
      <fieldset className="ws-checks" disabled={disabled}>
        <legend>{t('pharmacyFields.customersCan')}</legend>
        <label className="ws-check">
          <input type="checkbox" checked={form.pickupAvailable} onChange={(e) => set('pickupAvailable', e.target.checked)} /> {t('pharmacyFields.pickup')}
        </label>
        <label className="ws-check">
          <input type="checkbox" checked={form.deliveryAvailable} onChange={(e) => set('deliveryAvailable', e.target.checked)} /> {t('pharmacyFields.delivery')}
        </label>
      </fieldset>
    </>
  );
}
