import { PATIENT_LANGUAGES, type LabAddress } from '@jansetu/api';
import { TextField } from '@jansetu/ui';

/**
 * WQ19: form pieces every assisted booking shares (moved out of Book consultation and Book lab test so the lab front desk
 * uses the very same ones): the patient's language and the home-collection address.
 */

/** `preferredLanguage`: one of the patient languages (required by every assisted create). */
export function LanguageSelect({ id, value, error, onChange }: { id: string; value: string; error?: string; onChange: (code: string) => void }) {
  return (
    <div className="j-field">
      <label htmlFor={id}>Language the patient speaks</label>
      <select id={id} value={value} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
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
      <legend>Address for the home collection</legend>
      {field('line1', 'House and street')}
      {field('line2', 'Area (optional)')}
      <div className="rx-form-row">{field('city', 'City')}{field('pincode', 'Pincode')}</div>
      <div className="rx-form-row">{field('state', 'State (optional)')}{field('landmark', 'Landmark (optional)')}</div>
    </fieldset>
  );
}
