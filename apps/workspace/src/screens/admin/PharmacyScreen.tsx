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
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime, type Perform } from '../finance/finance.tsx';
import { NoSuchRecord } from './accountList.tsx';
import { useAdminScope } from './adminScope.ts';
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
  if (!OBJECT_ID_PATTERN.test(pharmacyId)) return (
    <NoSuchRecord back="/admin/pharmacies" backLabel={t('common.backToPharmacies')} title={t('pharmacy.title')} missing={t('pharmacy.noSuch')}>
      {t('pharmacy.openFromList')}
    </NoSuchRecord>
  );
  // One subtree per admin and pharmacy: a half-typed form never follows the admin to another pharmacy.
  return <PharmacyDetail key={`${scope.identity}:${pharmacyId}`} pharmacyId={pharmacyId} scopeKey={scope.key} />;
}

/** The fields of the details form (the sign-in contacts have their own, confirmed, change). */
type Details = Omit<PharmacyForm, 'phone' | 'email'>;
const detailsOf = (p: PharmacyAccount): Details => { const { phone: _p, email: _e, ...rest } = pharmacyForm(p); return rest; };
const DETAIL_LABEL = {
  name: 'pharmacy.field.name', nickname: 'pharmacy.field.nickname', ownerName: 'pharmacy.field.ownerName', address: 'pharmacy.field.address',
  city: 'pharmacy.field.city', state: 'pharmacy.field.state', pincode: 'pharmacy.field.pincode', gstNumber: 'pharmacy.field.gstNumber',
  drugLicenseNumber: 'pharmacy.field.drugLicenseNumber', pickupAvailable: 'pharmacy.field.pickupAvailable', deliveryAvailable: 'pharmacy.field.deliveryAvailable',
} as const satisfies Record<keyof Details, Parameters<typeof t>[0]>;
/** The fields someone else changed meanwhile, in words. */
const detailsStale = (fields: readonly (keyof Details)[]) => staleMessage(fields.map((k) => t(DETAIL_LABEL[k])));

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
      <Link className="ws-back" to="/admin/pharmacies"><ArrowLeft size={16} aria-hidden="true" /> {t('common.backToPharmacies')}</Link>
      <PageHeading title={p?.name ?? t('pharmacy.title')}>{p ? [p.ownerName, p.city].filter(Boolean).join(' · ') || null : null}</PageHeading>
      <div><Link to={`/admin/pharmacy-wallets/${pharmacyId}`}>{t('pharmacy.walletLink')}</Link> · <Link to={`/admin/pharmacies/${pharmacyId}/referral-cuts`}>{t('pharmacy.referralCutsLink')}</Link></div>
      {q.isPending ? <Loading label={t('pharmacy.loading')} />
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
      if (isRecordChanged(err)) say('warn', t('pharmacy.changedMeanwhile', { name }));
      else if (definitelyNotRecorded(err)) say('error', t('common.notChanged', { reason: messageOf(err) }));
      else {
        // The answer was lost: the pharmacy as saved now tells whether the change went through.
        const now = await readNow().catch(() => null);
        if (now && pharmacyHolds(now, body)) say('ok', done);
        else say('warn', t('pharmacy.notConfirmedStatus', { reason: messageOf(err) }));
      }
    } finally {
      await reread();
    }
  });
  return (
    <section className="ws-section" aria-labelledby="ph-state-h">
      <h2 id="ph-state-h">{t('common.status')}</h2>
      {outcome && <Alert tone={outcome.tone}>{outcome.text}</Alert>}
      <dl className="ws-dl">
        <dt>{t('common.status')}</dt><dd><PharmacyBadges p={p} /></dd>
        {p.archivedAt && <><dt>{t('pharmacy.archived')}</dt><dd>{formatDateTime(p.archivedAt)}{p.archiveReason ? ` (${p.archiveReason})` : ''}</dd></>}
        <dt>{t('pharmacy.pharmacist')}</dt><dd>{p.pharmacist ? `${p.pharmacist.name} (${p.pharmacist.registrationNumber})` : t('pharmacy.noPharmacist')}</dd>
        <dt>{t('common.added')}</dt><dd>{p.createdAt ? formatDateTime(p.createdAt) : '—'}</dd>
      </dl>
      <div className="ws-actions">
        {!s.verified && (
          <ConfirmAction key="verify" label={t('common.verify')} confirmLabel={t('common.verifyNamed', { name: p.name })} disabled={busy} version={p.updatedAt}
            consequence={t(s.active ? 'pharmacy.verify.consequence' : 'pharmacy.verify.consequenceInactive', { name: p.name })}
            onConfirm={(_r, openedOn) => act({ isVerified: true }, openedOn, t('pharmacy.verify.done', { name: p.name }))} />
        )}
        {s.active ? (
          <ConfirmAction key="deactivate" label={t('pharmacy.deactivate.label')} danger confirmLabel={t('pharmacy.deactivate.confirm', { name: p.name })} disabled={busy}
            version={p.updatedAt} consequence={t('pharmacy.deactivate.consequence', { name: p.name })}
            onConfirm={(_r, openedOn) => act({ isActive: false }, openedOn, t('pharmacy.deactivate.done', { name: p.name }))} />
        ) : p.archivedAt ? (
          <p className="ws-muted">{t('pharmacy.archivedNote', { name: p.name })}</p>
        ) : (
          <ConfirmAction key="activate" label={t('pharmacy.activate.label')} confirmLabel={t('pharmacy.activate.confirm', { name: p.name })} disabled={busy} version={p.updatedAt}
            consequence={t(s.verified ? 'pharmacy.activate.consequenceVerified' : 'pharmacy.activate.consequence', { name: p.name })}
            onConfirm={(_r, openedOn) => act({ isActive: true }, openedOn, t(s.verified ? 'pharmacy.activate.doneVerified' : 'pharmacy.activate.done', { name: p.name }))} />
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
    if (Object.keys(body).length === 0) { setNotice(t('pharmacy.nothingChanged')); return; }
    setReview(body);
  }
  const confirm = (body: PharmacyUpdate, baseline: { phone: string; email: string }) => perform(async () => {
    setError(null);
    try {
      const fresh = await readNow();
      if (!live.current) return;
      if (fresh.phone !== baseline.phone || (fresh.email ?? '') !== baseline.email) {
        setReview(null); setForm(pharmacyForm(fresh)); setOpen({ phone: fresh.phone, email: fresh.email ?? '' });
        setError(t('pharmacy.signIn.changedMeanwhile', { name: fresh.name }));
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
      const signsIn = saved.email ? t('pharmacy.signIn.savedBoth', { name: saved.name, phone: saved.phone, email: saved.email })
        : t('pharmacy.signIn.savedPhone', { name: saved.name, phone: saved.phone });
      setNotice(signedOut ? `${signsIn} ${t('pharmacy.signIn.signedOut')}` : signsIn);
    } catch (err) {
      if (!live.current) return;
      setReview(null);
      if (isRecordChanged(err)) {
        const now = await readNow().catch(() => null);
        if (!live.current) return;
        if (now) { setForm(pharmacyForm(now)); setOpen({ phone: now.phone, email: now.email ?? '' }); }
        setError(t('pharmacy.savingChanged', { name: p.name }));
      } else if (isPharmacyPhoneTaken(err)) setErrors({ phone: t('pharmacy.phoneTaken') });
      else if (isPharmacyEmailTaken(err)) setErrors({ email: t('pharmacy.emailTaken') });
      else setError(definitelyNotRecorded(err) ? messageOf(err) : t('pharmacy.notConfirmedDetails', { reason: messageOf(err) }));
    } finally {
      await reread();
    }
  });

  return (
    <section className="ws-section" aria-labelledby="ph-signin-h">
      <h2 id="ph-signin-h">{t('pharmacy.signIn.title')}</h2>
      <dl className="ws-dl">
        <dt>{t('pharmacy.mobileNumber')}</dt><dd>{p.phone}</dd>
        <dt>{t('pharmacy.email')}</dt><dd>{p.email || <span className="ws-muted">{t('pharmacy.noEmail')}</span>}</dd>
      </dl>
      {notice && <Alert tone="ok">{notice}</Alert>}
      {!open ? (
        <div><Button variant="secondary" disabled={busy} onClick={start}>{t('pharmacy.signIn.change')}</Button></div>
      ) : (
        <form className="rx-form" noValidate onSubmit={check}>
          <p className="ws-muted">{t('pharmacy.signIn.intro')}</p>
          <fieldset className="ws-frozen" disabled={busy}>
            <SignInFields form={form} errors={errors} set={set} />
          </fieldset>
          {error && <Alert>{error}</Alert>}
          {!review ? (
            <div className="ws-actions">
              <Button type="submit" disabled={busy}>{t('pharmacy.signIn.continue')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => { setOpen(null); setError(null); }}>{t('common.cancel')}</Button>
            </div>
          ) : (
            <div className="confirm" role="group" aria-label={t('pharmacy.signIn.confirmLabel')}>
              <div className="confirm-text">
                {review.phone && <p>{t('pharmacy.signIn.newPhone', { name: p.name, phone: review.phone, oldPhone: p.phone })}</p>}
                {review.email && <p>{p.email ? t('pharmacy.signIn.newEmail', { oldEmail: p.email, email: review.email }) : t('pharmacy.signIn.addedEmail', { email: review.email })}</p>}
                {review.email === null && p.email && <p>{t('pharmacy.signIn.removedEmail', { email: p.email })}</p>}
                {signsPharmacyOut(p, review) ? (
                  <p>
                    {t.rich('pharmacy.signIn.signsOutWhere', { signsOut: <strong key="out">{t('pharmacy.signIn.signsOut', { name: p.name })}</strong> })}
                  </p>
                ) : <p>{t('pharmacy.signIn.staysSignedIn')}</p>}
                <p>{t('pharmacy.signIn.tell')}</p>
              </div>
              <div className="confirm-actions">
                <Button busy={busy} onClick={() => void confirm(review, open).catch((err: unknown) => setError(messageOf(err)))}>{t('pharmacy.signIn.confirm')}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setReview(null)}>{t('common.back')}</Button>
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
    if (c.length) setStale(detailsStale(c));
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
    if (Object.keys(first.body).length === 0) { setNotice(t('pharmacy.nothingChanged')); return; }
    void perform(async () => {
      try {
        const fresh = await readNow();
        if (!live.current) return;
        const conflicts = rebaseTo(detailsOf(fresh));
        if (conflicts.length) { setStale(detailsStale(conflicts)); return; }
        const { body, errors: errs } = bodyOf(fresh);
        setErrors(errs);
        if (Object.keys(errs).length) return;
        if (Object.keys(body).length === 0) { setNotice(t('pharmacy.nothingChanged')); return; }
        try {
          await update(body, fresh.updatedAt);
        } catch (err) {
          if (isRecordChanged(err)) {
            const now = await readNow();
            if (!live.current) return;
            const c = rebaseTo(detailsOf(now));
            setStale(c.length ? detailsStale(c) : RECORD_CHANGED_MESSAGE);
            return;
          }
          if (definitelyNotRecorded(err)) throw err;
          if (!pharmacyHolds(await readNow(), body)) throw err; // the answer was lost: saved only if the record holds it
        }
        if (live.current) setNotice(t('pharmacy.details.saved'));
      } catch (err) {
        if (live.current) setError(messageOf(err));
      } finally {
        await reread();
      }
    }).catch((err: unknown) => setError(messageOf(err)));
  }

  return (
    <section className="ws-section" aria-labelledby="ph-details-h">
      <h2 id="ph-details-h">{t('pharmacy.details.title')}</h2>
      <form className="rx-form" noValidate onSubmit={save}>
        <p className="ws-muted">{t('pharmacy.details.intro')}</p>
        <fieldset className="ws-frozen" disabled={busy}>
          <DetailFields form={{ ...pharmacyForm(p), ...d.draft }} errors={errors} set={(k, v) => d.set(k as keyof Details, v as never)} />
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div><Button type="submit" busy={busy} disabled={busy}>{t('pharmacy.details.save')}</Button></div>
      </form>
    </section>
  );
}
