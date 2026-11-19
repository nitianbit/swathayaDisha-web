import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  ApiError, customerApi, maskTarget, MAX_EMAIL, normalizeEmail, OTP_PATTERN, targetKey, type CustomerProfile, type Gender, type ProfileUpdate,
} from '@jansetu/api';
import { Alert, Button, ErrorState, Loading, TextField, useCooldowns } from '@jansetu/ui';
import { Confirm, messageOf, PageHeading } from '../common.tsx';
import { useCustomer, useSession } from '../session.tsx';
import { missingProfileFields } from './HomeScreen.tsx';

const GENDERS: Gender[] = ['Female', 'Male', 'Other'];

/** YYYYMMDD ⇄ the date input's YYYY-MM-DD. */
const toInput = (d?: string) => (d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '');
const fromInput = (v: string) => v.replace(/-/g, '');

export function ProfileScreen() {
  const { api, signOut, signOutEverywhere } = useSession();
  const q = useQuery({ queryKey: ['me'], queryFn: () => customerApi(api).profile() });
  return (
    <>
      <PageHeading title="Profile" />
      {q.isPending ? <Loading /> : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : <>
          <ProfileForm key={q.data._id} profile={q.data} />
          <EmailSection key={`e:${q.data._id}`} profile={q.data} />
        </>}
      <section className="card stack" aria-labelledby="fam-h">
        <h2 id="fam-h">Family</h2>
        <Link to="/profile/family">Family members you book for</Link>
      </section>
      <section className="card stack" aria-labelledby="acct-h">
        <h2 id="acct-h">Account</h2>
        <Button variant="secondary" onClick={() => signOut()}>Sign out</Button>
        <Confirm label="Sign out on all devices" confirmLabel="Sign out everywhere"
          consequence="Every phone or browser signed in to your account will be signed out, including this one."
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
    onSuccess: (user) => queryClient.setQueryData(['me'], user),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const body: ProfileUpdate = {};
    if (name.trim().length < 2) errs.name = 'Enter your full name.'; else if (name.trim() !== (profile.name ?? '')) body.name = name.trim();
    // WQ9: the email is not saved from here: it is added by proving it (EmailSection).
    if (gender && gender !== profile.gender) body.gender = gender;
    if (dob) {
      const v = fromInput(dob);
      if (!/^\d{8}$/.test(v) || v > fromInput(new Date().toISOString().slice(0, 10))) errs.dob = 'Enter your date of birth.';
      else if (v !== profile.dateOfBirth) body.dateOfBirth = v;
    }
    setErrors(errs);
    if (Object.keys(errs).length === 0 && Object.keys(body).length > 0) save.mutate(body);
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="me-h">
      <h2 id="me-h">Your details</h2>
      {missing.length > 0 && <Alert tone="warn">Please complete: {missing.map((m) => LABEL[m]).join(', ')}.</Alert>}
      <TextField label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={100} />
      <div className="field-static"><span>Mobile number</span><strong>{profile.phone ?? '—'}</strong></div>
      <fieldset className="choice">
        <legend>Gender</legend>
        {GENDERS.map((g) => (
          <label key={g}><input type="radio" name="gender" checked={gender === g} onChange={() => setGender(g)} /> {g}</label>
        ))}
      </fieldset>
      <TextField label="Date of birth" type="date" value={dob} onChange={(e) => setDob(e.target.value)} error={errors.dob} />
      {save.isError && <Alert>{messageOf(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="ok">Saved.</Alert>}
      <Button type="submit" busy={save.isPending}>Save</Button>
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
        <h2 id="email-h">Email</h2>
        {done && <Alert tone="ok">Email added. You can now also sign in with it.</Alert>}
        <div className="field-static"><span>Email</span><strong>{profile.email}</strong>
          <small>You can sign in with it. To change it, contact support.</small></div>
      </section>
    );
  }

  const current = sentTo ?? normalizeEmail(typed);
  const wait = cooldowns.remaining(current ? targetKey({ email: current }) : null);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    const email = sentTo ?? normalizeEmail(typed);
    if (!email) { setFieldError('Enter a valid email address.'); return; }
    setFieldError(null);
    const mine = ++seq.current;
    setBusy(true);
    try {
      await customers.sendEmailCode(email);
      if (!live.current || seq.current !== mine) return;
      setSentTo(email); setOtp(''); cooldowns.start(targetKey({ email }), RESEND_SECONDS);
    } catch (err) {
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
    if (!OTP_PATTERN.test(otp)) { setFieldError('Enter the 6-digit code.'); return; }
    setFieldError(null);
    const mine = ++seq.current;
    setBusy(true);
    try {
      await customers.verifyEmailCode(sentTo, otp);
      // Added on the server: the profile shows it even if this section was left meanwhile.
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      if (live.current && seq.current === mine) setDone(true);
    } catch (err) {
      if (!live.current || seq.current !== mine) return;
      setError(messageOf(err));
      if (err instanceof ApiError && err.code === 'OTP_ATTEMPTS_EXCEEDED') setOtp(''); // this code is spent: send a new one
    } finally {
      if (live.current && seq.current === mine) setBusy(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="email-h">
      <h2 id="email-h">Email</h2>
      {error && <Alert>{error}</Alert>}
      {!sentTo ? (
        <form className="stack" noValidate onSubmit={(e) => void send(e)}>
          <TextField label="Email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL}
            value={typed} onChange={(e) => setTyped(e.target.value)} error={fieldError}
            hint="We will send a code to it. Once added, you can also sign in with it; only support can change it." />
          <Button type="submit" busy={busy} disabled={wait > 0}>{wait > 0 ? `Send code in ${wait}s` : 'Send code'}</Button>
        </form>
      ) : (
        <form className="stack" noValidate onSubmit={(e) => void verify(e)}>
          <p>We sent a 6-digit code to your email <strong>{maskTarget({ email: sentTo })}</strong>.</p>
          <TextField ref={codeRef} label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} error={fieldError} />
          <Button type="submit" busy={busy}>Verify and add email</Button>
          <div className="row-between">
            <Button variant="ghost" disabled={busy || wait > 0} onClick={() => void send()}>{wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setSentTo(null); setOtp(''); setError(null); setFieldError(null); }}>Use another email</Button>
          </div>
        </form>
      )}
    </section>
  );
}

const LABEL: Record<string, string> = { name: 'name', email: 'email', gender: 'gender', dateOfBirth: 'date of birth' };
