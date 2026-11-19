import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ApiError, maskTarget, MAX_EMAIL, OTP_PATTERN, PARTNER_KIND_LABEL, parseLoginIdentifier, targetKey, targetKind, type OtpTarget, type PartnerSelection,
} from '@jansetu/api';
import { Alert, Button, TextField } from '@jansetu/ui';
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
  // The destination the current code was sent to: verify and resend use exactly this one.
  const [target, setTarget] = useState<OtpTarget | null>(null);
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'identify' | 'code' | 'choose'>('identify');
  // Q7: several lab/clinic workspaces for this number. The one-use ticket lives only here, in memory.
  const [selection, setSelection] = useState<PartnerSelection | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  // The destination the countdown belongs to: another one can still be used (O1 limits are per destination).
  const [waitFor, setWaitFor] = useState('');
  const typed = parseLoginIdentifier(identifier);
  const current = step === 'identify' ? typed : target;
  const waiting = cooldown > 0 && !!current && waitFor === targetKey(current);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step]);
  const chooseRef = useRef<HTMLLegendElement>(null);
  useEffect(() => { if (step === 'choose') chooseRef.current?.focus(); }, [step]);

  /** Sends a code to what was typed (first send) or, on the code step, to the same destination again. */
  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    const to = step === 'identify' ? typed : target;
    if (!to) { setFieldError('Enter a 10-digit mobile number or an email address.'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      await requestCode(role, to);
      setTarget(to);
      setStep('code');
      setOtp('');
      setCooldown(RESEND_SECONDS); setWaitFor(targetKey(to));
    } catch (err) {
      setError(messageOf(err));
      // O1: a refused resend waits as long as the server says (the button counts down).
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) { setCooldown(Math.min(err.retryAfter, 24 * 3600)); setWaitFor(targetKey(to)); }
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!OTP_PATTERN.test(otp)) { setFieldError('Enter the 6-digit code.'); return; }
    if (!target) { setStep('identify'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      const choice = await verifyCode(role, target, otp);
      if (choice) {
        setSelection(choice);
        setChosen(choice.choices.length === 1 ? choice.choices[0]!.partnerId : '');
        setOtp('');
        setStep('choose');
        setBusy(false);
      }
    } catch (err) {
      setError(messageOf(err));
      if (err instanceof ApiError && err.code === 'OTP_ATTEMPTS_EXCEEDED') setOtp(''); // this code is spent: send a new one
      setBusy(false);
    }
  }

  async function open(e: FormEvent) {
    e.preventDefault();
    if (!selection) return;
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
            <fieldset className="login-roles">
              <legend>I am signing in as</legend>
              {ROLES.map((r) => (
                <label key={r.value} className="login-role">
                  <input type="radio" name="role" value={r.value} checked={role === r.value}
                    onChange={() => setRole(r.value)} />
                  {r.label}
                </label>
              ))}
            </fieldset>
            <TextField label="Mobile number or email" type="text" inputMode="email" autoComplete="username" autoCapitalize="none"
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
