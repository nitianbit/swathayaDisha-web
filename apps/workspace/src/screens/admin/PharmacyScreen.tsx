import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  isPharmacyEmailTaken, isPharmacyPhoneTaken, normalizeEmail, OBJECT_ID_PATTERN, pharmacyAdminApi, pharmacyBody, pharmacyForm,
  pharmacyHolds, pharmacyState, signsPharmacyOut, type PharmacyAccount, type PharmacyForm, type PharmacyUpdate,
} from '@jansetu/api';
import { Alert, Button, ErrorState, formatDateTime, Loading } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { changedFields, isRecordChanged, RECORD_CHANGED_MESSAGE, staleMessage, useDraft } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime, type Perform } from '../finance/finance.tsx';
import { NoSuchRecord } from './accountList.tsx';
import { useAdminScope } from './adminScope.ts';
import { EMAIL_TAKEN, PHONE_TAKEN } from './NewPharmacyScreen.tsx';
import { PharmacyBadges } from './PharmaciesScreen.tsx';
import { DetailFields, SignInFields } from './pharmacyFields.tsx';

/**
 * Admin: one pharmacy. Verify it, activate or deactivate it, edit its details and how it signs in (WQ10b). Q15: every save
 * names the `updatedAt` it was decided on (`expectedUpdatedAt`); 409 RECORD_CHANGED means someone else saved first, so
 * nothing was saved: the pharmacy is read again and shown.
 */
export function PharmacyScreen() {
  const { pharmacyId = '' } = useParams();
  const scope = useAdminScope('pharmacies');
  if (!OBJECT_ID_PATTERN.test(pharmacyId)) return <NoSuchRecord back="/admin/pharmacies" backLabel="Back to pharmacies" title="Pharmacy">Open it from the pharmacy list.</NoSuchRecord>;
  // One subtree per admin and pharmacy: a half-typed form never follows the admin to another pharmacy.
  return <PharmacyDetail key={`${scope.identity}:${pharmacyId}`} pharmacyId={pharmacyId} scopeKey={scope.key} />;
}

/** The fields of the details form (the sign-in contacts have their own, confirmed, change). */
type Details = Omit<PharmacyForm, 'phone' | 'email'>;
const detailsOf = (p: PharmacyAccount): Details => { const { phone: _p, email: _e, ...rest } = pharmacyForm(p); return rest; };
const DETAIL_LABEL: Record<keyof Details, string> = {
  name: 'name', nickname: 'short name', ownerName: 'owner’s name', address: 'address', city: 'city', state: 'state', pincode: 'PIN code',
  gstNumber: 'GST number', drugLicenseNumber: 'drug licence number', pickupAvailable: 'pickup', deliveryAvailable: 'delivery',
};

function PharmacyDetail({ pharmacyId, scopeKey }: { pharmacyId: string; scopeKey: readonly string[] }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const admin = pharmacyAdminApi(api);
  const key = [...scopeKey, 'one', pharmacyId];
  const q = useQuery({ queryKey: key, queryFn: () => admin.get(pharmacyId) });
  // One change to this pharmacy at a time (the central guard): a confirmation already open is refused while another runs.
  const guard = useOneAtATime('pharmacy');
  /** The server's record decides: read again after every answer, also a refusal. */
  const reread = () => queryClient.invalidateQueries({ queryKey: scopeKey });
  /** Reads the pharmacy now (and shows it), for the checks made right before a change. */
  const readNow = async () => {
    const fresh = await admin.get(pharmacyId);
    queryClient.setQueryData(key, fresh);
    return fresh;
  };
  const p = q.data;
  return (
    <>
      <Link className="ws-back" to="/admin/pharmacies"><ArrowLeft size={16} aria-hidden="true" /> Back to pharmacies</Link>
      <PageHeading title={p?.name ?? 'Pharmacy'}>{p ? [p.ownerName, p.city].filter(Boolean).join(' · ') || null : null}</PageHeading>
      <div><Link to={`/admin/pharmacy-wallets/${pharmacyId}`}>Wallet and adding money</Link> · <Link to={`/admin/pharmacies/${pharmacyId}/referral-cuts`}>Referral cuts</Link></div>
      {q.isPending ? <Loading label="Loading pharmacy…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <>
            <StateSection p={q.data} perform={guard.perform} busy={guard.busy} reread={reread} readNow={readNow}
              update={(body, version) => admin.update(pharmacyId, body, version)} />
            <SignInSection p={q.data} perform={guard.perform} busy={guard.busy} reread={reread} readNow={readNow}
              update={(body, version) => admin.update(pharmacyId, body, version)} />
            <DetailsSection p={q.data} perform={guard.perform} busy={guard.busy} reread={reread} readNow={readNow}
              update={(body, version) => admin.update(pharmacyId, body, version)} />
          </>
        )}
    </>
  );
}

interface SectionProps {
  p: PharmacyAccount;
  perform: Perform;
  busy: boolean;
  reread: () => Promise<void>;
  /** `version`: the `updatedAt` the change was decided on (409 RECORD_CHANGED when the pharmacy moved since). */
  update: (body: PharmacyUpdate, version: string | undefined) => Promise<PharmacyAccount>;
}

/**
 * Verify (customers can find it), activate or deactivate (whether it can sign in and be seen). Confirmed first, and sent
 * with the version the confirmation was OPENED on (WQ11b): each step has its own confirmation (keyed), which closes when
 * the pharmacy changes while it is open (ConfirmAction `version`), so nothing is ever confirmed on a record the admin did
 * not see. Every answer closes the confirmation and is told here, in the section: done, refused (nothing changed; the
 * pharmacy is read again), or lost (the pharmacy as read now says whether it went through).
 *
 * An archived pharmacy (`archivedAt`, the old delete) is never offered "Activate": activating does not undo the archive
 * (the backend still refuses it as inactive), so it is shown as archived, restored by the tech team.
 */
function StateSection({ p, perform, busy, reread, readNow, update }: SectionProps & { readNow: () => Promise<PharmacyAccount> }) {
  const s = pharmacyState(p);
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const say = (tone: 'ok' | 'warn' | 'error', text: string) => { if (live.current) setOutcome({ tone, text }); };
  const act = (body: PharmacyUpdate, openedOn: string | number | undefined, done: string) => perform(async () => {
    setOutcome(null);
    const name = p.name;
    try {
      await update(body, typeof openedOn === 'string' ? openedOn : undefined);
      say('ok', done);
    } catch (err) {
      if (isRecordChanged(err)) say('warn', `${name} was changed by someone else meanwhile, so nothing was changed. Check what is shown now and try again.`);
      else if (definitelyNotRecorded(err)) say('error', `Not changed: ${messageOf(err)}`);
      else {
        // The answer was lost: the pharmacy as saved now tells whether the change went through.
        const now = await readNow().catch(() => null);
        if (now && pharmacyHolds(now, body)) say('ok', done);
        else say('warn', `Not confirmed: ${messageOf(err)} The status shown is what is saved now; try again if it is still needed.`);
      }
    } finally {
      await reread();
    }
  });
  return (
    <section className="ws-section" aria-labelledby="ph-state-h">
      <h2 id="ph-state-h">Status</h2>
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      <dl className="ws-dl">
        <dt>Status</dt><dd><PharmacyBadges p={p} /></dd>
        {p.archivedAt && <><dt>Archived</dt><dd>{formatDateTime(p.archivedAt)}{p.archiveReason ? ` (${p.archiveReason})` : ''}</dd></>}
        <dt>Pharmacist</dt><dd>{p.pharmacist ? `${p.pharmacist.name} (${p.pharmacist.registrationNumber})` : 'Not added yet (the pharmacy adds it in its settings)'}</dd>
        <dt>Added</dt><dd>{p.createdAt ? formatDateTime(p.createdAt) : '—'}</dd>
      </dl>
      <div className="ws-actions">
        {!s.verified && (
          <ConfirmAction key="verify" label="Verify" confirmLabel={`Verify ${p.name}`} disabled={busy} version={p.updatedAt}
            consequence={`${p.name} is marked verified: customers can find it and order from it${s.active ? '' : ' once it is active again'}.`}
            onConfirm={(_r, openedOn) => act({ isVerified: true }, openedOn, `${p.name} is verified.`)} />
        )}
        {s.active ? (
          <ConfirmAction key="deactivate" label="Deactivate" danger confirmLabel={`Deactivate ${p.name}`} disabled={busy} version={p.updatedAt}
            consequence={`${p.name} can no longer sign in, and customers no longer see it. Its orders and stock stay as they are. You can activate it again.`}
            onConfirm={(_r, openedOn) => act({ isActive: false }, openedOn, `${p.name} was deactivated: it can no longer sign in, and customers no longer see it.`)} />
        ) : p.archivedAt ? (
          <p className="ws-muted">
            {p.name} is archived: it cannot sign in and customers do not see it. An archived pharmacy cannot be activated here; the
            tech team restores it if it should come back.
          </p>
        ) : (
          <ConfirmAction key="activate" label="Activate" confirmLabel={`Activate ${p.name}`} disabled={busy} version={p.updatedAt}
            consequence={`${p.name} can sign in again${s.verified ? ', and customers see it again' : '. Customers see it once it is verified'}.`}
            onConfirm={(_r, openedOn) => act({ isActive: true }, openedOn, `${p.name} is active again: it can sign in${s.verified ? ', and customers see it' : ''}.`)} />
        )}
      </div>
    </section>
  );
}

/**
 * The sign-in mobile number and email: the support path for changing them (the pharmacy's own profile edit leaves them
 * out). Reviewed and confirmed first, because it changes how the pharmacy signs in, and (Q15) a changed number, or a
 * changed or removed email, signs the pharmacy out. Right before sending, the pharmacy is read again: if its contacts
 * changed since the form opened, nothing is sent and the form shows them; the save names that read's version. The email
 * can be removed (sent as null); the mobile number cannot.
 */
function SignInSection({ p, perform, busy, reread, readNow, update }: SectionProps & { readNow: () => Promise<PharmacyAccount> }) {
  const [open, setOpen] = useState<{ phone: string; email: string } | null>(null);
  const [form, setForm] = useState<PharmacyForm>(() => pharmacyForm(p));
  const [review, setReview] = useState<PharmacyUpdate | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof PharmacyForm, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const set = <K extends keyof PharmacyForm>(k: K, v: PharmacyForm[K]) => { setForm((f) => ({ ...f, [k]: v })); setReview(null); };

  function start() {
    setForm(pharmacyForm(p)); setOpen({ phone: p.phone, email: p.email ?? '' });
    setReview(null); setErrors({}); setError(null); setNotice(null);
  }
  function check(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null);
    const fields = (['phone', 'email'] as const).filter((k) => (k === 'email' ? (normalizeEmail(form.email) ?? form.email.trim()) !== (p.email ?? '') : form.phone !== p.phone));
    const { body, errors: errs } = pharmacyBody(form, fields, p);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    if (Object.keys(body).length === 0) { setNotice('Nothing has changed.'); return; }
    setReview(body);
  }
  const confirm = (body: PharmacyUpdate, baseline: { phone: string; email: string }) => perform(async () => {
    setError(null);
    try {
      const fresh = await readNow();
      if (!live.current) return;
      if (fresh.phone !== baseline.phone || (fresh.email ?? '') !== baseline.email) {
        setReview(null); setForm(pharmacyForm(fresh)); setOpen({ phone: fresh.phone, email: fresh.email ?? '' });
        setError(`Someone else changed how ${fresh.name} signs in while you were editing, so nothing was changed. The form now shows what is saved; check it again.`);
        return;
      }
      const signedOut = signsPharmacyOut(fresh, body);
      let saved: PharmacyAccount;
      try {
        saved = await update(body, fresh.updatedAt);
      } catch (err) {
        if (definitelyNotRecorded(err)) throw err;
        // The answer was lost: the pharmacy as read now tells whether the change went through (the version fence makes a
        // late copy of it refused rather than saved over a newer change).
        const now = await readNow();
        if (!pharmacyHolds(now, body)) throw err;
        saved = now;
      }
      if (!live.current) return;
      setOpen(null); setReview(null);
      setNotice(`${saved.name} now signs in with ${saved.phone}${saved.email ? ` or ${saved.email}` : ' only'}.${signedOut ? ' It was signed out and signs in again with these.' : ''}`);
    } catch (err) {
      if (!live.current) return;
      setReview(null);
      if (isRecordChanged(err)) {
        const now = await readNow().catch(() => null);
        if (!live.current) return;
        if (now) { setForm(pharmacyForm(now)); setOpen({ phone: now.phone, email: now.email ?? '' }); }
        setError(`Someone else changed ${p.name} while you were saving, so nothing was changed. The form now shows what is saved; check it again.`);
      } else if (isPharmacyPhoneTaken(err)) setErrors({ phone: PHONE_TAKEN });
      else if (isPharmacyEmailTaken(err)) setErrors({ email: EMAIL_TAKEN });
      else setError(definitelyNotRecorded(err) ? messageOf(err) : `Not confirmed: ${messageOf(err)} Check the details shown and try again.`);
    } finally {
      await reread();
    }
  });

  return (
    <section className="ws-section" aria-labelledby="ph-signin-h">
      <h2 id="ph-signin-h">Sign-in</h2>
      <dl className="ws-dl">
        <dt>Mobile number</dt><dd>{p.phone}</dd>
        <dt>Email</dt><dd>{p.email || <span className="ws-muted">None</span>}</dd>
      </dl>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {!open ? (
        <div><Button variant="secondary" disabled={busy} onClick={start}>Change mobile number or email</Button></div>
      ) : (
        <form className="rx-form" noValidate onSubmit={check}>
          <p className="ws-muted">The pharmacy signs in with these. Change them only when the pharmacy asks and you have checked it is them.</p>
          <fieldset className="ws-frozen" disabled={busy}>
            <SignInFields form={form} errors={errors} set={set} />
          </fieldset>
          {error && <Alert>{error}</Alert>}
          {!review ? (
            <div className="ws-actions">
              <Button type="submit" disabled={busy}>Continue</Button>
              <Button variant="ghost" disabled={busy} onClick={() => { setOpen(null); setError(null); }}>Cancel</Button>
            </div>
          ) : (
            <div className="confirm" role="group" aria-label="Change how the pharmacy signs in">
              <div className="confirm-text">
                {review.phone && <p>From now on {p.name} signs in with mobile number {review.phone}; {p.phone} no longer works for signing in.</p>}
                {review.email && <p>{p.email ? `Its sign-in email changes from ${p.email} to ${review.email}; the old one no longer works.` : `It can also sign in with ${review.email}.`}</p>}
                {review.email === null && p.email && <p>Its sign-in email {p.email} is removed: it signs in with its mobile number only.</p>}
                {signsPharmacyOut(p, review) ? (
                  <p>
                    <strong>This signs {p.name} out</strong> on every computer and phone where it is signed in now. It signs in again with the
                    new details. An app signed in long ago may stay signed in; to stop all access at once, deactivate the pharmacy.
                  </p>
                ) : <p>Anyone already signed in stays signed in.</p>}
                <p>Tell the pharmacy before you change it.</p>
              </div>
              <div className="confirm-actions">
                <Button busy={busy} onClick={() => void confirm(review, open).catch((err: unknown) => setError(messageOf(err)))}>Change sign-in</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>Back</Button>
              </div>
            </div>
          )}
        </form>
      )}
    </section>
  );
}

/**
 * Name, owner, address, licences and pickup/delivery. Only fields changed from the baseline are sent, after reading the
 * pharmacy again: a field someone else changed meanwhile is shown for review, never overwritten. Q15: the save names that
 * read's `updatedAt`, so a change landing in between is refused (409 RECORD_CHANGED) and shown for review too. An
 * emptied optional field is cleared (sent as null); the name cannot be emptied.
 */
function DetailsSection({ p, perform, busy, reread, readNow, update }: SectionProps & { readNow: () => Promise<PharmacyAccount> }) {
  const d = useDraft(() => detailsOf(p));
  const { rebaseTo } = d;
  const [errors, setErrors] = useState<Partial<Record<keyof PharmacyForm, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const serverValue = JSON.stringify(detailsOf(p));
  useEffect(() => {
    const c = rebaseTo(JSON.parse(serverValue) as Details);
    if (c.length) setStale(staleMessage(c.map((k) => DETAIL_LABEL[k])));
  }, [serverValue, rebaseTo]);

  const bodyOf = (record: PharmacyAccount) => {
    const changed = Object.keys(changedFields(d.current())) as (keyof Details)[];
    return pharmacyBody({ ...pharmacyForm(record), ...d.current().draft }, changed, record);
  };

  function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setStale(null);
    const first = bodyOf(p);
    setErrors(first.errors);
    if (Object.keys(first.errors).length) return;
    if (Object.keys(first.body).length === 0) { setNotice('Nothing has changed.'); return; }
    void perform(async () => {
      try {
        const fresh = await readNow();
        if (!live.current) return;
        const conflicts = rebaseTo(detailsOf(fresh));
        if (conflicts.length) { setStale(staleMessage(conflicts.map((k) => DETAIL_LABEL[k]))); return; }
        const { body, errors: errs } = bodyOf(fresh);
        setErrors(errs);
        if (Object.keys(errs).length) return;
        if (Object.keys(body).length === 0) { setNotice('Nothing has changed.'); return; }
        try {
          await update(body, fresh.updatedAt);
        } catch (err) {
          if (isRecordChanged(err)) {
            const now = await readNow();
            if (!live.current) return;
            const c = rebaseTo(detailsOf(now));
            setStale(c.length ? staleMessage(c.map((k) => DETAIL_LABEL[k])) : RECORD_CHANGED_MESSAGE);
            return;
          }
          if (definitelyNotRecorded(err)) throw err;
          if (!pharmacyHolds(await readNow(), body)) throw err; // the answer was lost: saved only if the record holds it
        }
        if (live.current) setNotice('Saved.');
      } catch (err) {
        if (live.current) setError(messageOf(err));
      } finally {
        await reread();
      }
    }).catch((err: unknown) => setError(messageOf(err)));
  }

  return (
    <section className="ws-section" aria-labelledby="ph-details-h">
      <h2 id="ph-details-h">Details</h2>
      <form className="rx-form" noValidate onSubmit={save}>
        <p className="ws-muted">To remove an optional detail, empty its field and save. The name cannot be removed.</p>
        <fieldset className="ws-frozen" disabled={busy}>
          <DetailFields form={{ ...pharmacyForm(p), ...d.draft }} errors={errors} set={(k, v) => d.set(k as keyof Details, v as never)} />
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div><Button type="submit" busy={busy} disabled={busy}>Save details</Button></div>
      </form>
    </section>
  );
}
