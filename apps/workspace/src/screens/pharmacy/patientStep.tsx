import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, ASSISTED_GENDERS, LAB_CONSENT_STATEMENT, LAB_DESK_CONSENT_STATEMENT, LAB_TEST_CONSENT_STATEMENT, ASSISTED_RELATIONS, assistedRefusal, canonicalPhone, CONSULT_MODE_LABEL, CONSENT_STATEMENT, doctorToolsApi, EMPTY_PATIENT, familyBookedBefore,
  formatSlotDate, istToday, isSwitchedOff, MAX_PERSON_NAME, patientProblems, pharmacyAssistedApi, type AssistedGender, type AssistedRelation, type DoctorAppointment,
  type PatientDraft, type PatientLookup, type Refusal,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, Loading, TextField , Parts } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { useSession } from '../../session.tsx';
import type { Perform } from '../finance/finance.tsx';
import type { ConsultBooker } from './consultBooker.ts';
import { t } from '../../i18n/pharmacy/index.ts';
import { useVisitPreset, type VisitPatient } from '../front/visitPatient.ts';
import { VisitPatientLine } from '../front/visitBar.tsx';

/**
 * WQ17: the patient step of an assisted booking (WQ12, moved here unchanged from Book consultation so that Book lab test
 * uses the very same step): the phone lookup (`POST /pharmacy-assisted/patients/lookup`: the masked holder name only),
 * who the patient is (the owner, a family member booked before, a new family member), the "patient agreed" tick. The
 * phone stays in this state and in POST bodies: never in the address, storage or logs.
 */
export function usePatientStep({ pharmacyId, perform, onFind, onSwitchedOff, onChangePhone, lookupPatient, refusal, booker }: {
  /** The booker's identity (the pharmacy's id, or for the WQ19 lab desk the workspace's identity). */
  pharmacyId: string;
  perform: Perform;
  /**
   * WQ24: a consultation booker's own routes (a lab member's): its lookup, and family members it booked for before from its
   * own booked list (default: the pharmacy's).
   */
  booker?: Pick<ConsultBooker, 'api' | 'bookingsKey' | 'refusal'>;
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
  const assisted = booker?.api ?? pharmacyAssistedApi(api);
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
    setVisitOn(false);
    setPhoneText(''); setPhoneError(null); setLookup(null); setPatient(EMPTY_PATIENT); setPatientErrors({}); setAgreed(false); setAgreeError(null);
    setPatientDone(false);
  }

  // WQ54/WQ54b: opened from + New: the visit's patient (phone and name) is looked up once and shown, never asked again.
  const preset = useVisitPreset();
  // Only for the handed-over patient: a reset (another booking) or a changed number is the usual step again.
  const [visitOn, setVisitOn] = useState(true);
  const presetDone = useRef(false);
  useEffect(() => {
    if (!preset || presetDone.current) return;
    presetDone.current = true;
    setPhoneText(preset.phone);
    // WQ54c: + New looked the number up: it is not looked up (or counted) again.
    const phone = canonicalPhone(preset.phone);
    if (preset.lookup && phone) { setLookup({ phone, result: preset.lookup }); setPatient(visitDraft(preset, phone)); return; }
    void lookupPhone(preset.phone);
  }, []);

  async function find(e: FormEvent) {
    e.preventDefault();
    await lookupPhone(phoneText);
  }

  async function lookupPhone(raw: string) {
    onFind?.();
    const phone = canonicalPhone(raw);
    if (!phone) { setPhoneError(t('patientStep.enterAValid10Digit')); return; }
    setPhoneError(null);
    try {
      const result = await perform(() => (lookupPatient ?? assisted.lookup)(phone));
      setLookup({ phone, result });
      // WQ54b: the + New patient's name (none when + New had only a masked one: asked here), and the number counted as typed
      // twice only when it came from + New's search results (or was typed twice there).
      setPatient(preset && canonicalPhone(preset.phone) === phone ? visitDraft(preset, phone) : { ...EMPTY_PATIENT, phone });
      setPatientErrors({});
    } catch (err) {
      if (isSwitchedOff(err)) { onSwitchedOff(); return; }
      // WQ24b/WQ25: in the booker's own words (a lab's or a doctor's permission, branch and verification refusals).
      setPhoneError((refusal ?? booker?.refusal ?? assistedRefusal)(err).message);
    }
  }

  function changePhone() {
    setVisitOn(false);
    setLookup(null); setPatient(EMPTY_PATIENT); setPatientErrors({}); setAgreed(false); setPatientDone(false);
    onChangePhone?.();
  }

  // Family members this pharmacy booked for before on this number (its own list; the lookup never lists the family).
  const family = useQuery({
    queryKey: [...(booker?.bookingsKey ?? ['pharmacy-bookings', pharmacyId]), 'family-source'],
    queryFn: async () => {
      const first = await assisted.bookings({ limit: 50 });
      const second = first.nextCursor ? await assisted.bookings({ limit: 50, cursor: first.nextCursor }) : null;
      return [...first.items, ...(second?.items ?? [])];
    },
    enabled: !!lookup?.result.exists && !lookupPatient,
    staleTime: 60_000,
  });
  const knownFamily = useMemo(() => (lookup && family.data ? familyBookedBefore(family.data, lookup.phone) : []), [lookup, family.data]);
  // WQ27: only while that list is read (a booker with its own lookup never reads it: a disabled query stays "pending").
  const familyLoading = !!lookup?.result.exists && !lookupPatient && family.isPending;

  function patientNext(e: FormEvent) {
    e.preventDefault();
    if (!lookup) return;
    const problems = patientProblems({ ...patient, phone: lookup.phone }, lookup.result.exists);
    setPatientErrors(problems);
    setAgreeError(agreed ? null : t('patientStep.askThePatientThenTick'));
    if (Object.keys(problems).length || !agreed) return;
    setPatientDone(true);
  }

  const patientLabel = (): string => {
    if (patient.who === 'known') return knownFamily.find((f) => f.dependentId === patient.dependentId)?.name ?? t('patientStep.familyMember');
    const name = patient.name.trim().replace(/\s+/g, ' ');
    return patient.who === 'family' ? t('patientStep.familyOfOwner', { name, relation: patient.relation.toLowerCase() }) : name;
  };

  return {
    phoneText, setPhoneText, phoneError, lookup, patient, setPatient, set, patientErrors, agreed, setAgreed, agreeError, setAgreeError,
    patientDone, setPatientDone, family, knownFamily, familyLoading, find, changePhone, patientNext, patientLabel, reset, visit: visitOn ? preset : null,
  };
}

export type PatientStep = ReturnType<typeof usePatientStep>;

/**
 * WQ54b/WQ54c: the + New patient as the step's draft: who they are (the owner, or a family member with their details), the
 * name (none when + New had only a masked one: asked here), and the number counted as typed twice only when it came from
 * + New's search results (or was typed twice there).
 */
function visitDraft(p: VisitPatient, phone: string): PatientDraft {
  return { ...EMPTY_PATIENT, phone, name: p.name, phoneAgain: p.confirmed ? phone : '',
    ...(p.family ? { who: 'family' as const, relation: p.family.relation, gender: p.family.gender, dateOfBirth: p.family.dateOfBirth, holderName: p.family.holderName } : {}) };
}

/**
 * Step 1 of an assisted booking. `frozen`: the step cannot change now; `locked`: "Change patient details" is off.
 * WQ19: `booker` names who books ("pharmacy" or "lab"; WQ25 "doctor": you) and `consent` the statement the tick attests.
 */
export function PatientSection({ step, busy, frozen, locked, nextLabel = t('common.nextChooseTheDoctor'), booker = 'pharmacy', consent = CONSENT_STATEMENT, forTest = false }: {
  step: PatientStep; busy: boolean; frozen: boolean; locked: boolean; nextLabel?: string; booker?: 'pharmacy' | 'lab' | 'doctor'; consent?: string;
  /** WQ54c: the booking is a lab test (the agreement says so). */
  forTest?: boolean;
}) {
  const {
    phoneText, setPhoneText, phoneError, lookup, patient, setPatient, set, patientErrors, agreed, setAgreed, agreeError, setAgreeError,
    patientDone, setPatientDone, knownFamily, familyLoading, find, changePhone, patientNext,
  } = step;
  const frozenPatient = frozen;
  if (step.visit && (lookup || !phoneError)) return <VisitPatientSection step={step} frozen={frozen} locked={locked} nextLabel={nextLabel} consent={consent} forTest={forTest} />;
  return (
    <section className="ws-section" aria-labelledby="pt-h">
      <h2 id="pt-h">{t('patientStep.n1Patient')}</h2>
      {!lookup ? (
        <form className="ws-search" noValidate onSubmit={(e) => void find(e)}>
          <TextField label={t('patientStep.patientSMobileNumber')} inputMode="tel" autoComplete="off" value={phoneText} error={phoneError}
            hint={t('patientStep.theNumberThePatientOr')} onChange={(e) => setPhoneText(e.target.value)} />
          <Button type="submit" busy={busy}>{t('patientStep.find')}</Button>
        </form>
      ) : (
        <form className="rx-form" noValidate onSubmit={patientNext}>
          <div className="ws-actions">
            <span><Parts of={t.rich('patientStep.mobileNumberFull', { phone: <strong>{lookup.phone}</strong> })} /></span>
            <Button variant="ghost" disabled={frozenPatient} onClick={changePhone}>{t('patientStep.changeNumber')}</Button>
          </div>
          {lookup.result.exists ? (
            <Alert tone="ok"><Parts of={t.rich('patientStep.thisNumberIsOnJansetuFull', { holderNameMasked: <strong>{lookup.result.holderNameMasked ?? t('patientStep.nameNotGiven')}</strong> })} /></Alert>
          ) : (
            <Alert tone="warn">{t('patientStep.thisNumberIsNewTo')}</Alert>
          )}
          <fieldset className="ws-frozen" disabled={frozenPatient}>
            {!lookup.result.exists && (
              <TextField label={t('patientStep.typeTheNumberAgain')} inputMode="tel" autoComplete="off" value={patient.phoneAgain} error={patientErrors.phoneAgain}
                onChange={(e) => set('phoneAgain', e.target.value)} />
            )}
            <fieldset className="ws-checks" aria-describedby={patientErrors.dependentId ? 'who-err' : undefined}>
              <legend>{t('patientStep.whoIsThePatient')}</legend>
              <label className="ws-check">
                <input type="radio" name="who" checked={patient.who === 'self'} onChange={() => setPatient((d) => ({ ...d, who: 'self', dependentId: '' }))} />{t('patientStep.thePhoneSOwner')}{lookup.result.exists && lookup.result.holderNameMasked ? ` (${lookup.result.holderNameMasked})` : ''}
              </label>
              {knownFamily.map((f) => (
                <label key={f.dependentId} className="ws-check">
                  <input type="radio" name="who" checked={patient.who === 'known' && patient.dependentId === f.dependentId}
                    onChange={() => setPatient((d) => ({ ...d, who: 'known', dependentId: f.dependentId }))} />
                  {t('patientStep.familyMemberBookedHereBeforeFull', { name: f.name })}</label>
              ))}
              <label className="ws-check">
                <input type="radio" name="who" checked={patient.who === 'family'} onChange={() => setPatient((d) => ({ ...d, who: 'family', dependentId: '' }))} />
                {knownFamily.length ? t('patientStep.anotherFamilyMember') : t('patientStep.aFamilyMemberOfThe')}
              </label>
              {patientErrors.dependentId && <span id="who-err" className="j-field__error" role="alert">{patientErrors.dependentId}</span>}
            </fieldset>
            {familyLoading && <span className="ws-muted">{t('patientStep.lookingForFamilyMembersYou')}</span>}

            <PatientFields patient={patient} set={set} errors={patientErrors} booker={booker} />

            <AgreedTick agreed={agreed} setAgreed={setAgreed} agreeError={agreeError} setAgreeError={setAgreeError} consent={consent} forTest={forTest}
              doctor={booker === 'doctor'} />
          </fieldset>
          {patientDone ? (
            <div className="ws-actions">
              <Badge tone="ok">{t('patientStep.patientReady')}</Badge>
              <Button variant="ghost" disabled={locked} onClick={() => setPatientDone(false)}>{t('patientStep.changePatientDetails')}</Button>
            </div>
          ) : (
            <div><Button type="submit">{nextLabel}</Button></div>
          )}
        </form>
      )}
    </section>

  );
}

/**
 * The patient's own fields for who they are (WQ54c: shared by the full step and + New): the owner's name, or a family
 * member's name, relation, sex and date of birth, and the phone owner's name (only used the first time).
 */
export function PatientFields({ patient, set, errors: patientErrors, booker = 'pharmacy' }: {
  patient: PatientDraft; set: <K extends keyof PatientDraft>(k: K, v: PatientDraft[K]) => void; errors: Partial<Record<keyof PatientDraft, string>>;
  booker?: 'pharmacy' | 'lab' | 'doctor';
}) {
  return (
    <>
      {patient.who === 'self' && (
        <TextField label={t('patientStep.patientSFullName')} autoComplete="off" value={patient.name} maxLength={MAX_PERSON_NAME} error={patientErrors.name}
          hint={t('patientStep.typeTheNameThePatient')} onChange={(e) => set('name', e.target.value)} />
      )}
      {patient.who === 'family' && (
        <>
          <div className="rx-form-row">
            <TextField label={t('patientStep.familyMemberSFullName')} autoComplete="off" value={patient.name} maxLength={MAX_PERSON_NAME} error={patientErrors.name}
              onChange={(e) => set('name', e.target.value)} />
            <div className="j-field">
              <label htmlFor="pt-relation">{t('patientStep.relationToThePhoneS')}</label>
              <select id="pt-relation" value={patient.relation} aria-invalid={patientErrors.relation ? true : undefined}
                aria-describedby={patientErrors.relation ? 'pt-relation-err' : undefined}
                onChange={(e) => set('relation', e.target.value as AssistedRelation | '')}>
                <option value="">{t('common.choose3')}</option>
                {ASSISTED_RELATIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {patientErrors.relation && <span id="pt-relation-err" className="j-field__error" role="alert">{patientErrors.relation}</span>}
            </div>
          </div>
          <div className="rx-form-row">
            <div className="j-field">
              <label htmlFor="pt-gender">{t('patientStep.genderOptional')}</label>
              <select id="pt-gender" value={patient.gender} onChange={(e) => set('gender', e.target.value as AssistedGender | '')}>
                <option value="">{t('common.notSaid')}</option>
                {ASSISTED_GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <TextField label={t('patientStep.dateOfBirthOptional')} type="date" value={patient.dateOfBirth} max={istToday()} error={patientErrors.dateOfBirth}
              onChange={(e) => set('dateOfBirth', e.target.value)} />
          </div>
          <p className="ws-muted">{t('patientStep.ifThisFamilyMemberIs')}</p>
        </>
      )}
      {patient.who !== 'self' && (
        <TextField label={t('patientStep.phoneOwnerSNameOptional')} autoComplete="off" value={patient.holderName} maxLength={MAX_PERSON_NAME} error={patientErrors.holderName}
          hint={booker === 'doctor' ? t('patientStep.onlyUsedTheFirstTime') : t(`patientStep.onlyUsedTheFirstTime.${booker}`)}
          onChange={(e) => set('holderName', e.target.value)} />
      )}
    </>
  );
}

/**
 * WQ54d: the short line of the statement shown (it names what the statement allows). WQ54e: a pharmacy's and a doctor's
 * lab tests share one statement ("we"): the doctor's line says "you can see the report".
 */
function shortConsent(statement: string, forTest: boolean, doctor: boolean): string {
  if (statement === LAB_DESK_CONSENT_STATEMENT) return t('patientStep.consentShort.labDesk');
  if (statement === LAB_CONSENT_STATEMENT) return t('patientStep.consentShort.labConsult');
  if (statement === LAB_TEST_CONSENT_STATEMENT) return doctor ? t('patientStep.consentShort.doctorTest') : t('patientStep.consentShort.pharmacyTest');
  return forTest ? t('patientStep.consentShort.pharmacyTest') : t('patientStep.consentShort.pharmacyConsult');
}

/**
 * The "patient agreed" tick: one short plain sentence, the full statement it attests behind "Read more" (WQ54c; a lab
 * test's own sentence with `forTest`). `large` in a flow opened from + New.
 */
function AgreedTick({ agreed, setAgreed, agreeError, setAgreeError, consent, large, forTest, doctor }: {
  agreed: boolean; setAgreed: (b: boolean) => void; agreeError: string | null; setAgreeError: (e: string | null) => void; consent: string; large?: boolean;
  forTest?: boolean;
  /** A doctor books (the doctor's own words). */
  doctor?: boolean;
}) {
  return (
    <>
      <label className={large ? 'rx-ack visit-consent' : 'rx-ack'}>
        <input type="checkbox" checked={agreed} aria-describedby={agreeError ? 'agree-err' : 'agree-text'}
          onChange={(e) => { setAgreed(e.target.checked); if (e.target.checked) setAgreeError(null); }} />{t('patientStep.patientAgreedToThisBooking')}</label>
      <span id="agree-text" className="j-field__hint">{shortConsent(consent, !!forTest, !!doctor)}</span>
      <details className="consent-more">
        <summary>{t('patientStep.consentReadMore')}</summary>
        <p className="j-field__hint">{consent}</p>
      </details>
      {agreeError && <span id="agree-err" className="j-field__error" role="alert">{agreeError}</span>}
    </>
  );
}

/**
 * WQ54b: the patient step of a flow opened from + New: "Patient: Asha [Change]" (no "Who is the patient?", no second
 * number), the name only when + New had none, and the agreement tick, large. A lookup that fails shows the usual step.
 */
function VisitPatientSection({ step, frozen, locked, nextLabel, consent, forTest }: {
  step: PatientStep; frozen: boolean; locked: boolean; nextLabel: string; consent: string; forTest: boolean;
}) {
  const { visit, lookup, patient, set, patientErrors, agreed, setAgreed, agreeError, setAgreeError, patientDone, setPatientDone, patientNext } = step;
  if (!visit) return null;
  return (
    <section className="ws-section" aria-labelledby="pt-h">
      <h2 id="pt-h">{t('patientStep.n1Patient')}</h2>
      <VisitPatientLine patient={visit} canChange={!locked} />
      {!lookup ? <Loading /> : (
        <form className="rx-form" noValidate onSubmit={patientNext}>
          <fieldset className="ws-frozen" disabled={frozen}>
            {(!visit.name || patientErrors.name) && (
              <TextField label={t('patientStep.patientSFullName')} autoComplete="off" value={patient.name} maxLength={MAX_PERSON_NAME} error={patientErrors.name}
                hint={t('patientStep.typeTheNameThePatient')} onChange={(e) => set('name', e.target.value)} />
            )}
            {!lookup.result.exists && (!visit.confirmed || patientErrors.phoneAgain) && (
              <TextField label={t('patientStep.typeTheNumberAgain')} inputMode="tel" autoComplete="off" value={patient.phoneAgain} error={patientErrors.phoneAgain}
                onChange={(e) => set('phoneAgain', e.target.value)} />
            )}
            <AgreedTick agreed={agreed} setAgreed={setAgreed} agreeError={agreeError} setAgreeError={setAgreeError} consent={consent} large forTest={forTest} />
          </fieldset>
          {patientDone ? (
            <div className="ws-actions">
              <Badge tone="ok">{t('patientStep.patientReady')}</Badge>
              <Button variant="ghost" disabled={locked} onClick={() => setPatientDone(false)}>{t('patientStep.changePatientDetails')}</Button>
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
    // Review (WQ25): only what the step says is kept; the rest of the booking (its prescription, the concern) is never
    // cached. The pick is in the query itself: a `select` alone would leave the whole answer in the cache.
    queryFn: async () => consultationWords(await doctorToolsApi(api).appointment(fromBookingId!)),
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
    setNameError(!typedName ? t('patientStep.typeThePatientSName') : typedName.length > MAX_PERSON_NAME ? t('patientStep.useAtMostCharacters', { MAX_PERSON_NAME }) : null);
    setAgreeError(agreed ? null : t('patientStep.askThePatientThenTick'));
    if (!typedName || typedName.length > MAX_PERSON_NAME || !agreed) return;
    setDone(true);
  }
  function reset() { setName(''); setNameError(null); setAgreed(false); setAgreeError(null); setDone(false); }

  return { fromBookingId, consultation, name, setName, nameError, agreed, setAgreed, agreeError, setAgreeError, done, setDone, typedName, next, reset };
}

export type ConsultationPatient = ReturnType<typeof useConsultationPatient>;

/** The consultation as the step names it: its date, time, way and whether it is a family member's. */
export const consultationWords = (b: DoctorAppointment) =>
  ({ bookingDate: b.bookingDate, bookingTime: b.bookingTime, consultationMode: b.consultationMode, family: !!b.dependentId });

/** Step 1 when booking from a consultation; `walkInPath` books by mobile number instead. */
export function ConsultationPatientSection({ step, frozen, locked, consent, walkInPath }: {
  step: ConsultationPatient; frozen: boolean; locked: boolean; consent: string; walkInPath: string;
}) {
  const { consultation: q, name, setName, nameError, agreed, setAgreed, agreeError, setAgreeError, done, setDone, next } = step;
  const b = q.data;
  const missing = q.isError && q.error instanceof ApiError && q.error.status === 404;
  return (
    <section className="ws-section" aria-labelledby="pt-h">
      <h2 id="pt-h">{t('patientStep.n1Patient')}</h2>
      {q.isPending ? <Loading label={t('common.loadingTheConsultation')} />
        : missing ? <Alert>{t('patientStep.thisConsultationWasNotFound')}</Alert>
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <p><Parts of={t.rich(b?.family ? 'patientStep.fromConsultationFamily' : 'patientStep.fromConsultation', { when: <strong>{formatSlotDate(b?.bookingDate)}, {b?.bookingTime}</strong>, mode: b?.consultationMode ? ` (${CONSULT_MODE_LABEL[b.consultationMode] ?? b.consultationMode})` : '' })} /></p>
        )}
      <p className="ws-muted"><Link to={walkInPath}>{t('patientStep.bookForAPatientBy')}</Link></p>
      {!missing && (
        <form className="rx-form" noValidate onSubmit={next}>
          <fieldset className="ws-frozen" disabled={frozen}>
            <TextField label={t('patientStep.patientSFullName')} autoComplete="off" value={name} maxLength={MAX_PERSON_NAME} error={nameError}
              hint={b?.family ? t('patientStep.typeTheNameThePatient2') : t('patientStep.typeTheNameThePatient')}
              onChange={(e) => setName(e.target.value)} />
            <AgreedTick agreed={agreed} setAgreed={setAgreed} agreeError={agreeError} setAgreeError={setAgreeError} consent={consent} forTest doctor />
          </fieldset>
          {done ? (
            <div className="ws-actions">
              <Badge tone="ok">{t('patientStep.patientReady')}</Badge>
              <Button variant="ghost" disabled={locked} onClick={() => setDone(false)}>{t('patientStep.changePatientDetails')}</Button>
            </div>
          ) : (
            <div><Button type="submit">{t('common.nextChooseTheLab')}</Button></div>
          )}
        </form>
      )}
    </section>
  );
}
