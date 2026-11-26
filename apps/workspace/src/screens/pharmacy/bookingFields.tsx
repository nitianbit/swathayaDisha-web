import { getLanguage } from '@jansetu/i18n';
import { canonicalPhone, MAX_CONCERN, PATIENT_LANGUAGES, type BookerKind, type JoinOn, type LabAddress } from '@jansetu/api';
import { TextArea, TextField } from '@jansetu/ui';
import { t } from '../../i18n/pharmacy/index.ts';

/**
 * WQ19: form pieces every assisted booking shares (moved out of Book consultation and Book lab test so the lab front desk
 * uses the very same ones): the patient's language and the home-collection address.
 */

/** `preferredLanguage`: one of the patient languages (required by every assisted create). */
/** WQ55b: the patient's language starts as the workspace's (English when the patient list has no such language). */
export const defaultPatientLanguage = (): string => {
  const ui = getLanguage();
  return PATIENT_LANGUAGES.some((l) => l.code === ui) ? ui : 'en';
};

export function LanguageSelect({ id, value, error, onChange }: { id: string; value: string; error?: string; onChange: (code: string) => void }) {
  return (
    <div className="j-field">
      <label htmlFor={id}>{t('bookingFields.languageThePatientSpeaks')}</label>
      <select id={id} value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('common.choose3')}</option>
        {PATIENT_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
      </select>
      {error && <span id={`${id}-err`} className="j-field__error" role="alert">{error}</span>}
    </div>
  );
}

export type AddressDraft = { line1: string; line2: string; city: string; state: string; pincode: string; landmark: string };
export const EMPTY_ADDRESS: AddressDraft = { line1: '', line2: '', city: '', state: '', pincode: '', landmark: '' };

/** The address as the lab creates take it: trimmed, optional parts only when typed. */
export const labAddressOf = (a: AddressDraft): LabAddress => ({
  line1: a.line1.trim(), city: a.city.trim(), pincode: a.pincode.trim(),
  ...(a.line2.trim() ? { line2: a.line2.trim() } : {}), ...(a.state.trim() ? { state: a.state.trim() } : {}),
  ...(a.landmark.trim() ? { landmark: a.landmark.trim() } : {}),
});
export const labAddressLine = (a: LabAddress) => [a.line1, a.city, a.pincode].join(', ');

/** The home-collection address; `errors` keyed `address.<field>` (from `addressErrors`). */
export function AddressFields({ value, errors, onChange }: { value: AddressDraft; errors: Record<string, string>; onChange: (a: AddressDraft) => void }) {
  const field = (k: keyof AddressDraft, label: string) => (
    <TextField label={label} autoComplete="off" value={value[k]} error={errors[`address.${k}`]} inputMode={k === 'pincode' ? 'numeric' : undefined}
      onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
  );
  return (
    <fieldset className="ws-checks">
      <legend>{t('bookingFields.addressForTheHomeCollection')}</legend>
      {field('line1', t('bookingFields.houseAndStreet'))}
      {field('line2', t('bookingFields.areaOptional'))}
      <div className="rx-form-row">{field('city', 'City')}{field('pincode', 'Pincode')}</div>
      <div className="rx-form-row">{field('state', t('bookingFields.stateOptional'))}{field('landmark', t('bookingFields.landmarkOptional'))}</div>
    </fieldset>
  );
}

// ── WQ22: where the patient joins a video or phone consultation, and the consultation's extras (Book consultation, Consult now) ──

export interface JoinDraft { on: JoinOn | ''; phone: string }
export const EMPTY_JOIN: JoinDraft = { on: '', phone: '' };

/** The join's problems for a video or phone consultation (`joinOn`, `joinPhone`); none for in person. */
export function joinProblems(mode: string, j: JoinDraft): Record<string, string> {
  if (mode !== 'video' && mode !== 'call') return {};
  const e: Record<string, string> = {};
  if (!j.on) e.joinOn = t('bookingFields.chooseWhereThePatientJoins');
  if (mode === 'call' && j.on === 'patient_phone' && j.phone.trim() && !canonicalPhone(j.phone)) e.joinPhone = t('bookingFields.enterAValid10Digit');
  return e;
}
/** The `join` sent: the number to call only for a phone call on the patient's own phone (empty: the patient's number). */
export function joinOf(mode: string, j: JoinDraft): { on: JoinOn; phone?: string } | undefined {
  if ((mode !== 'video' && mode !== 'call') || !j.on) return undefined;
  return { on: j.on, ...(mode === 'call' && j.on === 'patient_phone' && j.phone.trim() ? { phone: canonicalPhone(j.phone)! } : {}) };
}

/** "Where does the patient join?" (and the number to call), for a video or phone consultation (WQ24: `org` names the booker). */
export function JoinFields({ mode, value, errors, onChange, org = 'pharmacy' }: {
  mode: string; value: JoinDraft; errors: Record<string, string>; onChange: (j: JoinDraft) => void; org?: BookerKind;
}) {
  if (mode !== 'video' && mode !== 'call') return null;
  return (
    <>
      <fieldset className="ws-checks">
        <legend>{t('bookingFields.whereDoesThePatientJoin')}</legend>
        <label className="ws-check">
          <input type="radio" name="join" checked={value.on === 'partner_device'} onChange={() => onChange({ ...value, on: 'partner_device' })} />
          {mode === 'call' ? t(`bookingFields.doctorCallsThis.${org}`) : t(`bookingFields.onThisDevice.${org}`)}
        </label>
        <label className="ws-check">
          <input type="radio" name="join" checked={value.on === 'patient_phone'} onChange={() => onChange({ ...value, on: 'patient_phone' })} />{t('bookingFields.onThePatientSOwn')}</label>
        {errors.joinOn && <span className="j-field__error" role="alert">{errors.joinOn}</span>}
      </fieldset>
      {mode === 'call' && value.on === 'patient_phone' && (
        <TextField label={t('bookingFields.numberTheDoctorShouldCall')} inputMode="tel" autoComplete="off" value={value.phone} error={errors.joinPhone}
          hint={t('bookingFields.leaveEmptyToUseThe')} onChange={(e) => onChange({ ...value, phone: e.target.value })} />
      )}
    </>
  );
}

export interface ConsultExtrasDraft { language: string; coupon: string; concern: string }
export const EMPTY_EXTRAS: ConsultExtrasDraft = { language: '', coupon: '', concern: '' };
/** The extras' problems (`language`, `coupon`, `concern`) and the coupon as sent (upper case, or none). */
export function consultExtrasProblems(x: ConsultExtrasDraft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!x.language) e.language = t('common.chooseTheLanguageThePatient');
  if (x.concern.trim().length > MAX_CONCERN) e.concern = t('bookingFields.useAtMostCharacters', { MAX_CONCERN });
  const code = x.coupon.trim().toUpperCase();
  if (code && !/^[A-Z0-9_-]{2,50}$/.test(code)) e.coupon = t('common.checkTheCouponCodeLetters');
  return e;
}
export const couponOf = (x: ConsultExtrasDraft) => x.coupon.trim().toUpperCase();

/** The language the patient speaks, a coupon, and a few words for the doctor. */
export function ConsultExtras({ value, errors, onChange }: { value: ConsultExtrasDraft; errors: Record<string, string>; onChange: (x: ConsultExtrasDraft) => void }) {
  return (
    <>
      <div className="rx-form-row">
        <LanguageSelect id="pt-lang" value={value.language} error={errors.language} onChange={(language) => onChange({ ...value, language })} />
        <TextField label={t('common.couponCodeOptional')} value={value.coupon} error={errors.coupon} maxLength={50}
          hint={t('common.onlyIfThePatientHas')} onChange={(e) => onChange({ ...value, coupon: e.target.value })} />
      </div>
      <TextArea label={t('bookingFields.whatIsTheProblemOptional')} autoComplete="off" value={value.concern} maxLength={MAX_CONCERN} error={errors.concern}
        hint={t('bookingFields.aFewWordsForThe')} onChange={(e) => onChange({ ...value, concern: e.target.value })} />
    </>
  );
}
