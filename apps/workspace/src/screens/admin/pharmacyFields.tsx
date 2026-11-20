import {
  MAX_DRUG_LICENSE, MAX_EMAIL, MAX_GST_NUMBER, MAX_PHARMACY_NAME, MAX_PHARMACY_NICKNAME, MAX_PHARMACY_OWNER, type PharmacyForm,
} from '@jansetu/api';
import { TextField } from '@jansetu/ui';

type Errors = Partial<Record<keyof PharmacyForm, string>>;
type Set = <K extends keyof PharmacyForm>(k: K, v: PharmacyForm[K]) => void;

/** The sign-in fields: the mobile number (required) and an optional email. */
export function SignInFields({ form, errors, set, disabled }: { form: PharmacyForm; errors: Errors; set: Set; disabled?: boolean }) {
  return (
    <div className="rx-form-row">
      <TextField label="Mobile number" inputMode="numeric" maxLength={10} value={form.phone} error={errors.phone} disabled={disabled} autoComplete="off"
        hint="The pharmacy signs in with this number (a code by SMS)."
        onChange={(e) => set('phone', e.target.value.replace(/\D/g, ''))} />
      <TextField label="Email (optional)" type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL} autoComplete="off"
        value={form.email} error={errors.email} disabled={disabled} hint="It can also sign in with this email (a code by email)."
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
        <TextField label="Pharmacy name" maxLength={MAX_PHARMACY_NAME} {...text('name')} />
        <TextField label="Short name (optional)" maxLength={MAX_PHARMACY_NICKNAME} {...text('nickname')} />
        <TextField label="Owner’s name (optional)" maxLength={MAX_PHARMACY_OWNER} {...text('ownerName')} />
      </div>
      <div className="rx-form-row">
        <TextField label="Address (optional)" {...text('address')} />
        <TextField label="City (optional)" {...text('city')} />
        <TextField label="State (optional)" {...text('state')} />
        <TextField label="PIN code (optional)" inputMode="numeric" maxLength={6} {...text('pincode')} />
      </div>
      <div className="rx-form-row">
        <TextField label="GST number (optional)" maxLength={MAX_GST_NUMBER} {...text('gstNumber')} />
        <TextField label="Drug licence number (optional)" maxLength={MAX_DRUG_LICENSE} {...text('drugLicenseNumber')} />
      </div>
      <fieldset className="ws-checks" disabled={disabled}>
        <legend>Customers can</legend>
        <label className="ws-check">
          <input type="checkbox" checked={form.pickupAvailable} onChange={(e) => set('pickupAvailable', e.target.checked)} /> Pick up at the pharmacy
        </label>
        <label className="ws-check">
          <input type="checkbox" checked={form.deliveryAvailable} onChange={(e) => set('deliveryAvailable', e.target.checked)} /> Get a delivery
        </label>
      </fieldset>
    </>
  );
}
