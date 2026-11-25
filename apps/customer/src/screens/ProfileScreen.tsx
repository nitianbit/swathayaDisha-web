import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, customerApi, maskTarget, MAX_EMAIL, normalizeEmail, OTP_PATTERN, targetKey, type CustomerProfile, type Gender, type ProfileUpdate,
} from '@jansetu/api';
import { Alert, Button, ErrorState, LanguageSwitcher, Loading, Parts, shared, TextField, useCooldowns } from '@jansetu/ui';
import { Confirm, genderLabel, messageOf, PageHeading } from '../common.tsx';
import { t, type CustomerKey } from '../i18n/index.ts';
import { useCustomer, useSession } from '../session.tsx';
import { missingProfileFields } from './HomeScreen.tsx';
import { RecordsLink } from './records/RecordsScreen.tsx';

const GENDERS: Gender[] = ['Female', 'Male', 'Other'];

/** YYYYMMDD ⇄ the date input's YYYY-MM-DD. */
const toInput = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '');
const fromInput = (v: string) => v.replace(/-/g, '');

export function ProfileScreen() {
  const { api, signOut, signOutEverywhere } = useSession();
  const me = useCustomer();
  const q = useQuery({ queryKey: ['me', me.id], queryFn: () => customerApi(api).profile() });
  return (
    <>
      <PageHeading title={t('nav.profile')} />
      <LanguageSwitcher className="card" />
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <>
          <ProfileForm key={q.data._id} profile={q.data} />
          <EmailSection key={`e:${q.data._id}`} profile={q.data} />
        </>}
      <section className="card stack" aria-labelledby="fam-h">
        <h2 id="fam-h">{t('profile.family')}</h2>
        <Link to="/profile/family">{t('profile.familyLink')}</Link>
        {/* WQ28: requests to see records, and who can see them. */}
        <RecordsLink />
      </section>
      <section className="card stack" aria-labelledby="acct-h">
        <h2 id="acct-h">{t('profile.account')}</h2>
        <Button variant="secondary" onClick={() => signOut()}>{t('profile.signOut')}</Button>
        <Confirm label={t('profile.signOutAll')} confirmLabel={t('profile.signOutEverywhere')}
          consequence={t('profile.signOutAllConsequence')}
          onConfirm={() => signOutEverywhere()} />
      </section>
    </>
  );
}

function ProfileForm({ profile }: { profile: CustomerProfile }) {
  const { api } = useSession();
  const me = useCustomer();
  const queryClient = useQueryClient();
  const [name, setName] = useState(profile.name ?? '');
  const [gender, setGender] = useState<Gender | ''>(profile.gender ?? '');
  const [dob, setDob] = useState(toInput(profile.dateOfBirth));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const missing = missingProfileFields(profile);

  const save = useMutation({
    mutationFn: (body: ProfileUpdate) => customerApi(api).updateProfile(me.id, body),
    onSuccess: (user) => queryClient.setQueryData(['me', me.id], user),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const body: ProfileUpdate = {};
    if (name.trim().length < 2) errs.name = t('profile.nameMissing'); else if (name.trim() !== (profile.name ?? '')) body.name = name.trim();
    // WQ9: the email is not saved from here: it is added by proving it (EmailSection).
    if (gender && gender !== profile.gender) body.gender = gender;
    if (dob) {
      const v = fromInput(dob);
      if (!/^\d{8}$/.test(v) || v > fromInput(new Date().toISOString().slice(0, 10))) errs.dob = t('profile.dobMissing');
      else if (v !== profile.dateOfBirth) body.dateOfBirth = v;
    }
    setErrors(errs);
    if (Object.keys(errs).length === 0 && Object.keys(body).length > 0) save.mutate(body);
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="me-h">
      <h2 id="me-h">{t('profile.details')}</h2>
      {missing.length > 0 && <Alert tone="warn">{t('profile.complete', { fields: missing.map((m) => t(FIELD[m])).join(', ') })}</Alert>}
      <TextField label={t('profile.fullName')} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={100} />
      <div className="field-static"><span>{t('profile.mobile')}</span><strong>{profile.phone ?? '—'}</strong></div>
      <fieldset className="choice">
        <legend>{t('profile.gender')}</legend>
        {GENDERS.map((g) => (
          <label key={g}><input type="radio" name="gender" checked={gender === g} onChange={() => setGender(g)} /> {genderLabel(g)}</label>
        ))}
      </fieldset>
      <TextField label={t('profile.dob')} type="date" value={dob} onChange={(e) => setDob(e.target.value)} error={errors.dob} />
      {save.isError && <Alert>{messageOf(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="ok">{t('profile.saved')}</Alert>}
      <Button type="submit" busy={save.isPending}>{shared('action.save')}</Button>
    </form>
  );
}

const RESEND_SECONDS = 30;

/**
 * WQ9: the email, added by proving it (a code sent to it), after which the person can also sign in with it. Only a
 * missing email can be added here; changing one needs support (422 EMAIL_CHANGE_ADMIN_ONLY). The address and the code
 * stay in this component's memory; an answer settles only while this section is on screen and it is the latest request.
 */
function EmailSection({ profile }: { profile: CustomerProfile }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const customers = customerApi(api);
  const [typed, setTyped] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const cooldowns = useCooldowns();
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const seq = useRef(0);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (sentTo) codeRef.current?.focus(); }, [sentTo]);

  if (profile.email) {
    return (
      <section className="card stack" aria-labelledby="email-h">
        <h2 id="email-h">{t('common.email')}</h2>
        {done && <Alert tone="ok">{t('profile.emailAdded')}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div className="field-static"><span>{t('common.email')}</span><strong>{profile.email}</strong>
          <small>{t('profile.emailFixed')}</small></div>
      </section>
    );
  }

  /** The email was set or changed elsewhere (422 EMAIL_CHANGE_ADMIN_ONLY, 409 CONTACT_CHANGED): show the profile as it is now. */
  async function profileMoved(err: unknown) {
    if (err instanceof ApiError && (err.code === 'EMAIL_CHANGE_ADMIN_ONLY' || err.code === 'CONTACT_CHANGED')) {
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    }
  }

  const current = sentTo ?? normalizeEmail(typed);
  const wait = cooldowns.remaining(current ? targetKey({ email: current }) : null);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    const email = sentTo ?? normalizeEmail(typed);
    if (!email) { setFieldError(t('profile.emailInvalid')); return; }
    setFieldError(null);
    const mine = ++seq.current;
    setBusy(true);
    try {
      await customers.sendEmailCode(email);
      if (!live.current || seq.current !== mine) return;
      setSentTo(email); setOtp(''); cooldowns.start(targetKey({ email }), RESEND_SECONDS);
    } catch (err) {
      await profileMoved(err);
      if (!live.current || seq.current !== mine) return;
      setError(messageOf(err));
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) cooldowns.start(targetKey({ email }), Math.min(err.retryAfter, 24 * 3600));
    } finally {
      if (live.current && seq.current === mine) setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!sentTo) return;
    if (!OTP_PATTERN.test(otp)) { setFieldError(t('code.missing')); return; }
    setFieldError(null);
    const mine = ++seq.current;
    setBusy(true);
    try {
      await customers.verifyEmailCode(sentTo, otp);
      // Added on the server: the profile shows it even if this section was left meanwhile.
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      if (live.current && seq.current === mine) setDone(true);
    } catch (err) {
      await profileMoved(err);
      if (!live.current || seq.current !== mine) return;
      setError(messageOf(err));
      if (err instanceof ApiError && err.code === 'OTP_ATTEMPTS_EXCEEDED') setOtp(''); // this code is spent: send a new one
    } finally {
      if (live.current && seq.current === mine) setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="email-h">
      <h2 id="email-h">{t('common.email')}</h2>
      {error && <Alert>{error}</Alert>}
      {!sentTo ? (
        <form className="stack" noValidate onSubmit={(e) => void send(e)}>
          <TextField label={t('common.email')} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL}
            value={typed} onChange={(e) => setTyped(e.target.value)} error={fieldError}
            hint={t('profile.emailHint')} />
          <Button type="submit" busy={busy} disabled={wait > 0}>{wait > 0 ? t('code.sendIn', { seconds: wait }) : t('code.send')}</Button>
        </form>
      ) : (
        <form className="stack" noValidate onSubmit={(e) => void verify(e)}>
          <p><Parts of={t.rich('code.sentEmail', { target: <strong>{maskTarget({ email: sentTo })}</strong> })} /></p>
          <TextField ref={codeRef} label={t('common.sixDigitCode')} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} error={fieldError} />
          <Button type="submit" busy={busy}>{t('profile.verifyEmail')}</Button>
          <div className="row-between">
            <Button variant="ghost" disabled={busy || wait > 0} onClick={() => void send()}>{wait > 0 ? t('common.resendCodeIn', { seconds: wait }) : t('common.resendCode')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setSentTo(null); setOtp(''); setError(null); setFieldError(null); }}>{t('profile.otherEmail')}</Button>
          </div>
        </form>
      )}
    </section>
  );
}

const FIELD: Readonly<Record<ReturnType<typeof missingProfileFields>[number], CustomerKey>> = {
  name: 'profile.field.name', email: 'profile.field.email', gender: 'profile.field.gender', dateOfBirth: 'profile.field.dateOfBirth',
};
