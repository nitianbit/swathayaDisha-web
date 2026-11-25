import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, ASSISTED_GENDERS, ASSISTED_RELATIONS, assistedRefusal, canonicalPhone, CONSULT_MODE_LABEL, CONSENT_STATEMENT, doctorToolsApi, EMPTY_PATIENT, familyBookedBefore,
  formatSlotDate, istToday, isSwitchedOff, MAX_PERSON_NAME, patientProblems, pharmacyAssistedApi, type AssistedGender, type AssistedRelation, type PatientDraft,
  type PatientLookup, type Refusal,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { useSession } from '../../session.tsx';
import type { Perform } from '../finance/finance.tsx';

/**
 * WQ17: the patient step of an assisted booking (WQ12, moved here unchanged from Book consultation so that Book lab test
 * uses the very same step): the phone lookup (`POST /pharmacy-assisted/patients/lookup`: the masked holder name only),
 * who the patient is (the owner, a family member booked before, a new family member), the "patient agreed" tick. The
 * phone stays in this state and in POST bodies: never in the address, storage or logs.
 */
export function usePatientStep({ pharmacyId, perform, onFind, onSwitchedOff, onChangePhone, lookupPatient, refusal = assistedRefusal }: {
  /** The booker's identity (the pharmacy's id, or for the WQ19 lab desk the workspace's identity). */
  pharmacyId: string;
  perform: Perform;
  /**
   * WQ19: another booker's lookup (the lab desk's `POST /lab-desk/patients/lookup`). With it, family members booked before
   * are not offered (only a pharmacy has that list): a family member is typed by name.
   */
  lookupPatient?: (phone: string) => Promise<PatientLookup>;
  /** WQ25: the booker's words for a refused lookup (a doctor's account, r26). */
  refusal?: (err: unknown) => Refusal;
  /** Before a lookup (clears the page's notice). */
  onFind?: () => void;
  /** The lookup answered that booking for patients is switched off. */
  onSwitchedOff: () => void;
  /** The number was changed: what was chosen for the old one goes. */
  onChangePhone?: () => void;
}) {
  const { api } = useSession();
  const assisted = pharmacyAssistedApi(api);
  const [phoneText, setPhoneText] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{ phone: string; result: PatientLookup } | null>(null);
  const [patient, setPatient] = useState<PatientDraft>(EMPTY_PATIENT);
  const [patientErrors, setPatientErrors] = useState<Partial<Record<keyof PatientDraft, string>>>({});
  const [agreed, setAgreed] = useState(false);
  const [agreeError, setAgreeError] = useState<string | null>(null);
  const [patientDone, setPatientDone] = useState(false);

  const set = <K extends keyof PatientDraft>(k: K, v: PatientDraft[K]) => setPatient((d) => ({ ...d, [k]: v }));

  function reset() {
    setPhoneText(''); setPhoneError(null); setLookup(null); setPatient(EMPTY_PATIENT); setPatientErrors({}); setAgreed(false); setAgreeError(null);
    setPatientDone(false);
  }

  async function find(e: FormEvent) {
    e.preventDefault();
    onFind?.();
    const phone = canonicalPhone(phoneText);
    if (!phone) { setPhoneError('Enter a valid 10-digit mobile number.'); return; }
    setPhoneError(null);
    try {
      const result = await perform(() => (lookupPatient ?? assisted.lookup)(phone));
      setLookup({ phone, result });
      setPatient({ ...EMPTY_PATIENT, phone });
      setPatientErrors({});
    } catch (err) {
      if (isSwitchedOff(err)) { onSwitchedOff(); return; }
      setPhoneError(refusal(err).message);
    }
  }

  function changePhone() {
    setLookup(null); setPatient(EMPTY_PATIENT); setPatientErrors({}); setAgreed(false); setPatientDone(false);
    onChangePhone?.();
  }

  // Family members this pharmacy booked for before on this number (its own list; the lookup never lists the family).
  const family = useQuery({
    queryKey: ['pharmacy-bookings', pharmacyId, 'family-source'],
    queryFn: async () => {
      const first = await assisted.bookings({ limit: 50 });
      const second = first.nextCursor ? await assisted.bookings({ limit: 50, cursor: first.nextCursor }) : null;
      return [...first.items, ...(second?.items ?? [])];
    },
    enabled: !!lookup?.result.exists && !lookupPatient,
    staleTime: 60_000,
  });
  const knownFamily = useMemo(() => (lookup && family.data ? familyBookedBefore(family.data, lookup.phone) : []), [lookup, family.data]);

  function patientNext(e: FormEvent) {
    e.preventDefault();
    if (!lookup) return;
    const problems = patientProblems({ ...patient, phone: lookup.phone }, lookup.result.exists);
    setPatientErrors(problems);
    setAgreeError(agreed ? null : 'Ask the patient, then tick this box. Without it you cannot book.');
    if (Object.keys(problems).length || !agreed) return;
    setPatientDone(true);
  }

  const patientLabel = (): string => {
    if (patient.who === 'known') return knownFamily.find((f) => f.dependentId === patient.dependentId)?.name ?? 'Family member';
    const name = patient.name.trim().replace(/\s+/g, ' ');
    return patient.who === 'family' ? `${name} (${patient.relation.toLowerCase()} of the phone’s owner)` : name;
  };

  return {
    phoneText, setPhoneText, phoneError, lookup, patient, setPatient, set, patientErrors, agreed, setAgreed, agreeError, setAgreeError,
    patientDone, setPatientDone, family, knownFamily, find, changePhone, patientNext, patientLabel, reset,
  };
}

export type PatientStep = ReturnType<typeof usePatientStep>;

/**
 * Step 1 of an assisted booking. `frozen`: the step cannot change now; `locked`: "Change patient details" is off.
 * WQ19: `booker` names who books ("pharmacy" or "lab"; WQ25 "doctor": you) and `consent` the statement the tick attests.
 */
export function PatientSection({ step, busy, frozen, locked, nextLabel = 'Next: choose the doctor', booker = 'pharmacy', consent = CONSENT_STATEMENT }: {
  step: PatientStep; busy: boolean; frozen: boolean; locked: boolean; nextLabel?: string; booker?: 'pharmacy' | 'lab' | 'doctor'; consent?: string;
}) {
  const {
    phoneText, setPhoneText, phoneError, lookup, patient, setPatient, set, patientErrors, agreed, setAgreed, agreeError, setAgreeError,
    patientDone, setPatientDone, family, knownFamily, find, changePhone, patientNext,
  } = step;
  const frozenPatient = frozen;
  return (
    <section className="ws-section" aria-labelledby="pt-h">
      <h2 id="pt-h">1. Patient</h2>
      {!lookup ? (
        <form className="ws-search" noValidate onSubmit={(e) => void find(e)}>
          <TextField label="Patient’s mobile number" inputMode="tel" autoComplete="off" value={phoneText} error={phoneError}
            hint="The number the patient (or their family) uses. A family can share one number." onChange={(e) => setPhoneText(e.target.value)} />
          <Button type="submit" busy={busy}>Find</Button>
        </form>
      ) : (
        <form className="rx-form" noValidate onSubmit={patientNext}>
          <div className="ws-actions">
            <span>Mobile number <strong>{lookup.phone}</strong></span>
            <Button variant="ghost" disabled={frozenPatient} onClick={changePhone}>Change number</Button>
          </div>
          {lookup.result.exists ? (
            <Alert tone="ok">
              This number is on Jansetu. Account holder: <strong>{lookup.result.holderNameMasked ?? 'name not given'}</strong>.
              {' '}Only part of the name is shown, to protect the patient.
            </Alert>
          ) : (
            <Alert tone="warn">This number is new to Jansetu. An account is made for it when you book.</Alert>
          )}
          <fieldset className="ws-frozen" disabled={frozenPatient}>
            {!lookup.result.exists && (
              <TextField label="Type the number again" inputMode="tel" autoComplete="off" value={patient.phoneAgain} error={patientErrors.phoneAgain}
                onChange={(e) => set('phoneAgain', e.target.value)} />
            )}
            <fieldset className="ws-checks" aria-describedby={patientErrors.dependentId ? 'who-err' : undefined}>
              <legend>Who is the patient?</legend>
              <label className="ws-check">
                <input type="radio" name="who" checked={patient.who === 'self'} onChange={() => setPatient((d) => ({ ...d, who: 'self', dependentId: '' }))} />
                The phone’s owner{lookup.result.exists && lookup.result.holderNameMasked ? ` (${lookup.result.holderNameMasked})` : ''}
              </label>
              {knownFamily.map((f) => (
                <label key={f.dependentId} className="ws-check">
                  <input type="radio" name="who" checked={patient.who === 'known' && patient.dependentId === f.dependentId}
                    onChange={() => setPatient((d) => ({ ...d, who: 'known', dependentId: f.dependentId }))} />
                  {f.name} (family member, booked here before)
                </label>
              ))}
              <label className="ws-check">
                <input type="radio" name="who" checked={patient.who === 'family'} onChange={() => setPatient((d) => ({ ...d, who: 'family', dependentId: '' }))} />
                {knownFamily.length ? 'Another family member' : 'A family member of the phone’s owner'}
              </label>
              {patientErrors.dependentId && <span id="who-err" className="j-field__error" role="alert">{patientErrors.dependentId}</span>}
            </fieldset>
            {lookup.result.exists && family.isPending && <span className="ws-muted">Looking for family members you booked for before…</span>}

            {patient.who === 'self' && (
              <TextField label="Patient’s full name" autoComplete="off" value={patient.name} maxLength={MAX_PERSON_NAME} error={patientErrors.name}
                hint="Type the name the patient tells you." onChange={(e) => set('name', e.target.value)} />
            )}
            {patient.who === 'family' && (
              <>
                <div className="rx-form-row">
                  <TextField label="Family member’s full name" autoComplete="off" value={patient.name} maxLength={MAX_PERSON_NAME} error={patientErrors.name}
                    onChange={(e) => set('name', e.target.value)} />
                  <div className="j-field">
                    <label htmlFor="pt-relation">Relation to the phone’s owner</label>
                    <select id="pt-relation" value={patient.relation} aria-invalid={patientErrors.relation ? true : undefined}
                      aria-describedby={patientErrors.relation ? 'pt-relation-err' : undefined}
                      onChange={(e) => set('relation', e.target.value as AssistedRelation | '')}>
                      <option value="">Choose…</option>
                      {ASSISTED_RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                    {patientErrors.relation && <span id="pt-relation-err" className="j-field__error" role="alert">{patientErrors.relation}</span>}
                  </div>
                </div>
                <div className="rx-form-row">
                  <div className="j-field">
                    <label htmlFor="pt-gender">Gender (optional)</label>
                    <select id="pt-gender" value={patient.gender} onChange={(e) => set('gender', e.target.value as AssistedGender | '')}>
                      <option value="">Not said</option>
                      {ASSISTED_GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>
                  <TextField label="Date of birth (optional)" type="date" value={patient.dateOfBirth} max={istToday()} error={patientErrors.dateOfBirth}
                    onChange={(e) => set('dateOfBirth', e.target.value)} />
                </div>
                <p className="ws-muted">If this family member is already on the account with the same name and relation, they are used; otherwise they are added.</p>
              </>
            )}
            {patient.who !== 'self' && (
              <TextField label="Phone owner’s name (optional)" autoComplete="off" value={patient.holderName} maxLength={MAX_PERSON_NAME} error={patientErrors.holderName}
                hint={booker === 'doctor' ? 'Only used the first time you book on this number.' : `Only used the first time your ${booker} books on this number.`}
                onChange={(e) => set('holderName', e.target.value)} />
            )}

            <label className="rx-ack">
              <input type="checkbox" checked={agreed} aria-describedby={agreeError ? 'agree-err' : 'agree-text'}
                onChange={(e) => { setAgreed(e.target.checked); if (e.target.checked) setAgreeError(null); }} />
              Patient agreed to this booking
            </label>
            <span id="agree-text" className="j-field__hint">{consent}</span>
            {agreeError && <span id="agree-err" className="j-field__error" role="alert">{agreeError}</span>}
          </fieldset>
          {patientDone ? (
            <div className="ws-actions">
              <Badge tone="ok">Patient ready</Badge>
              <Button variant="ghost" disabled={locked} onClick={() => setPatientDone(false)}>Change patient details</Button>
            </div>
          ) : (
            <div><Button type="submit">{nextLabel}</Button></div>
          )}
        </form>
      )}
    </section>

  );
}

// ── WQ25: the patient of the doctor's own consultation (backend r26, design §25.5.3) ──

/**
 * A doctor books for the patient of one of its consultations (`fromBookingId` + `typedName`): no phone is named, so no
 * lookup is counted. The consultation is read (`GET /specialists/me/appointments/:id`, the booking only) to say which one;
 * the server decides whether it is still open (its treating window). The name is typed by the doctor (the names rule: the
 * account name is never shown); for a family member's consultation the server keeps the family member's own name.
 */
export function useConsultationPatient({ doctorId, fromBookingId }: { doctorId: string; fromBookingId?: string }) {
  const { api } = useSession();
  const consultation = useQuery({
    queryKey: ['doctor', doctorId, 'lab-source', fromBookingId],
    queryFn: () => doctorToolsApi(api).appointment(fromBookingId!),
    enabled: !!fromBookingId,
    retry: (n, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && n < 2,
  });
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [agreeError, setAgreeError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const typedName = name.trim().replace(/\s+/g, ' ');

  function next(e: FormEvent) {
    e.preventDefault();
    setNameError(!typedName ? 'Type the patient’s name.' : typedName.length > MAX_PERSON_NAME ? `Use at most ${MAX_PERSON_NAME} characters.` : null);
    setAgreeError(agreed ? null : 'Ask the patient, then tick this box. Without it you cannot book.');
    if (!typedName || typedName.length > MAX_PERSON_NAME || !agreed) return;
    setDone(true);
  }
  function reset() { setName(''); setNameError(null); setAgreed(false); setAgreeError(null); setDone(false); }

  return { fromBookingId, consultation, name, setName, nameError, agreed, setAgreed, agreeError, setAgreeError, done, setDone, typedName, next, reset };
}

export type ConsultationPatient = ReturnType<typeof useConsultationPatient>;

/** Step 1 when booking from a consultation; `walkInPath` books by mobile number instead. */
export function ConsultationPatientSection({ step, frozen, locked, consent, walkInPath }: {
  step: ConsultationPatient; frozen: boolean; locked: boolean; consent: string; walkInPath: string;
}) {
  const { consultation: q, name, setName, nameError, agreed, setAgreed, agreeError, setAgreeError, done, setDone, next } = step;
  const b = q.data;
  const missing = q.isError && q.error instanceof ApiError && q.error.status === 404;
  return (
    <section className="ws-section" aria-labelledby="pt-h">
      <h2 id="pt-h">1. Patient</h2>
      {q.isPending ? <Loading label="Loading the consultation…" />
        : missing ? <Alert>This consultation was not found among yours.</Alert>
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <p>
            From your consultation on <strong>{formatSlotDate(b?.bookingDate)}, {b?.bookingTime}</strong>
            {b?.consultationMode ? ` (${CONSULT_MODE_LABEL[b.consultationMode] ?? b.consultationMode})` : ''}{b?.dependentId ? ', for a family member' : ''}.
          </p>
        )}
      <p className="ws-muted"><Link to={walkInPath}>Book for a patient by mobile number instead</Link></p>
      {!missing && (
        <form className="rx-form" noValidate onSubmit={next}>
          <fieldset className="ws-frozen" disabled={frozen}>
            <TextField label="Patient’s full name" autoComplete="off" value={name} maxLength={MAX_PERSON_NAME} error={nameError}
              hint={b?.dependentId ? 'Type the name the patient tells you. For a family member, Jansetu keeps the name on their profile.' : 'Type the name the patient tells you.'}
              onChange={(e) => setName(e.target.value)} />
            <label className="rx-ack">
              <input type="checkbox" checked={agreed} aria-describedby={agreeError ? 'agree-err' : 'agree-text'}
                onChange={(e) => { setAgreed(e.target.checked); if (e.target.checked) setAgreeError(null); }} />
              Patient agreed to this booking
            </label>
            <span id="agree-text" className="j-field__hint">{consent}</span>
            {agreeError && <span id="agree-err" className="j-field__error" role="alert">{agreeError}</span>}
          </fieldset>
          {done ? (
            <div className="ws-actions">
              <Badge tone="ok">Patient ready</Badge>
              <Button variant="ghost" disabled={locked} onClick={() => setDone(false)}>Change patient details</Button>
            </div>
          ) : (
            <div><Button type="submit">Next: choose the lab</Button></div>
          )}
        </form>
      )}
    </section>
  );
}
