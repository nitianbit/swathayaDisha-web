import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError, EMAIL_NOT_REGISTERED_MESSAGE, isEmailNotRegistered, maskTarget, MAX_EMAIL, OTP_PATTERN, PARTNER_KIND_LABEL, parseLoginIdentifier,
  targetKey, targetKind, type OtpTarget, type PartnerSelection,
} from '@jansetu/api';
import { Alert, Button, TextField, useCooldowns } from '@jansetu/ui';
import { messageOf } from '../errors.ts';
import { useSession, type StaffRole } from '../session.tsx';

const RESEND_SECONDS = 30;
const ROLES: { value: StaffRole; label: string }[] = [
  { value: 'pharmacy', label: 'Pharmacy staff' },
  { value: 'partner', label: 'Lab or clinic staff' },
  { value: 'specialist', label: 'Doctor' },
  { value: 'admin', label: 'Admin' },
];

export function LoginScreen({ notice }: { notice?: string }) {
  const { requestCode, verifyCode, choosePartner } = useSession();
  const [role, setRole] = useState<StaffRole>('pharmacy');
  // WQ9: a mobile number or an email, as typed. Kept in memory only (never stored, logged or put in a URL).
  const [identifier, setIdentifier] = useState('');
  // The role and destination the current code was sent for: verify, resend and the workspace choice use exactly these.
  const [sent, setSent] = useState<{ role: StaffRole; target: OtpTarget } | null>(null);
  const target = sent?.target ?? null;
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'identify' | 'code' | 'choose'>('identify');
  // Q7: several lab/clinic workspaces for this number. The one-use ticket lives only here, in memory.
  const [selection, setSelection] = useState<PartnerSelection | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  // O1 limits are per destination: each one keeps its own wait (A → B → A keeps A's), in memory only.
  const cooldowns = useCooldowns();
  const typed = parseLoginIdentifier(identifier);
  const current = step === 'identify' ? typed : target;
  const cooldown = cooldowns.remaining(current ? targetKey(current) : null);
  const waiting = cooldown > 0;
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step]);
  const chooseRef = useRef<HTMLLegendElement>(null);
  useEffect(() => { if (step === 'choose') chooseRef.current?.focus(); }, [step]);

  /** Sends a code to what was typed (first send) or, on the code step, to the same destination again. */
  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    // The role is captured with the destination (the role choice is frozen while sending).
    const next = step === 'identify' ? (typed ? { role, target: typed } : null) : sent;
    if (!next) { setFieldError('Enter a 10-digit mobile number or an email address.'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      await requestCode(next.role, next.target);
      setSent(next);
      setStep('code');
      setOtp('');
      cooldowns.start(targetKey(next.target), RESEND_SECONDS);
    } catch (err) {
      if (isEmailNotRegistered(err)) notRegistered(err);
      else setError(messageOf(err));
      // O1: a refused resend waits as long as the server says (the button counts down).
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) cooldowns.start(targetKey(next.target), Math.min(err.retryAfter, 24 * 3600));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!OTP_PATTERN.test(otp)) { setFieldError('Enter the 6-digit code.'); return; }
    if (!sent) { setStep('identify'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      const choice = await verifyCode(sent.role, sent.target, otp);
      if (choice) {
        setSelection(choice);
        setChosen(choice.choices.length === 1 ? choice.choices[0]!.partnerId : '');
        setOtp('');
        setStep('choose');
        setBusy(false);
      }
    } catch (err) {
      if (isEmailNotRegistered(err)) notRegistered(err);
      else setError(messageOf(err));
      if (err instanceof ApiError && err.code === 'OTP_ATTEMPTS_EXCEEDED') setOtp(''); // this code is spent: send a new one
      setBusy(false);
    }
  }

  /** WQ9: no account starts from an email: said on the field, with the way on (sign in by mobile, add the email). */
  function notRegistered(err: unknown) {
    setStep('identify');
    setFieldError(err instanceof ApiError && err.message ? err.message : EMAIL_NOT_REGISTERED_MESSAGE);
  }

  async function open(e: FormEvent) {
    e.preventDefault();
    // Q7: only a lab/clinic sign-in has a workspace choice, opened for the role the code was sent for.
    if (!selection || sent?.role !== 'partner') return;
    setError(null);
    if (!selection.choices.some((c) => c.partnerId === chosen)) { setFieldError('Choose the workspace to open.'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      await choosePartner(selection.ticket, chosen);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SELECTION_EXPIRED') {
        // One use, 5 minutes: a new code is the only way on.
        setSelection(null);
        setStep('code');
        setError('This sign-in has expired. Request a new code to continue.');
      } else {
        setError(messageOf(err));
      }
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="ws-brand login-brand">Jansetu <span>Workspace</span></div>
        <h1 id="page-title" tabIndex={-1}>Sign in</h1>
        {notice && <Alert tone="warn">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}

        {step === 'identify' ? (
          <form onSubmit={send} className="login-form" noValidate>
            <fieldset className="login-roles" disabled={busy}>
              <legend>I am signing in as</legend>
              {ROLES.map((r) => (
                <label key={r.value} className="login-role">
                  <input type="radio" name="role" value={r.value} checked={role === r.value}
                    onChange={() => setRole(r.value)} />
                  {r.label}
                </label>
              ))}
            </fieldset>
            <TextField label="Mobile number or email" type="text" inputMode="text" autoComplete="username" autoCapitalize="none"
              spellCheck={false} maxLength={MAX_EMAIL} value={identifier} onChange={(e) => setIdentifier(e.target.value)}
              error={fieldError} hint="We will send a 6-digit code by SMS to a mobile number, or to an email address." />
            <Button type="submit" busy={busy} disabled={waiting}>{waiting ? `Send code in ${cooldown}s` : 'Send code'}</Button>
          </form>
        ) : step === 'choose' && selection ? (
          <form onSubmit={(e) => void open(e)} className="login-form" noValidate>
            <fieldset className="login-roles" aria-describedby={fieldError ? 'choose-error' : undefined}>
              <legend ref={chooseRef} tabIndex={-1}>
                Your {target && targetKind(target) === 'email' ? 'email' : 'number'} belongs to several workspaces. Which one do you want to open?
              </legend>
              {selection.choices.map((c) => (
                <label key={c.partnerId} className="login-role">
                  <input type="radio" name="workspace" value={c.partnerId} checked={chosen === c.partnerId}
                    onChange={() => setChosen(c.partnerId)} />
                  <span>
                    <strong>{c.name}</strong>
                    <span className="login-choice-meta">
                      {PARTNER_KIND_LABEL[c.kind] ?? c.kind}{c.solo ? ' · single-doctor practice' : ''} · {c.role === 'owner' ? 'Owner' : 'Staff'}
                    </span>
                  </span>
                </label>
              ))}
              {fieldError && <span id="choose-error" className="j-field__error">{fieldError}</span>}
            </fieldset>
            <Button type="submit" busy={busy}>Open workspace</Button>
            <div className="login-actions">
              <Button variant="ghost" disabled={busy}
                onClick={() => { setSelection(null); setStep('identify'); setError(null); setFieldError(null); }}>
                Start again
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={verify} className="login-form" noValidate>
            {target && <p>We sent a 6-digit code to your {targetKind(target)} <strong>{maskTarget(target)}</strong>.</p>}
            <TextField ref={codeRef} label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} error={fieldError} />
            <Button type="submit" busy={busy}>Verify and sign in</Button>
            <div className="login-actions">
              <Button variant="ghost" disabled={busy || waiting} onClick={() => void send()}>
                {waiting ? `Resend code in ${cooldown}s` : 'Resend code'}
              </Button>
              <Button variant="ghost" disabled={busy}
                onClick={() => { setStep('identify'); setError(null); setFieldError(null); }}>
                Change number or email
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
