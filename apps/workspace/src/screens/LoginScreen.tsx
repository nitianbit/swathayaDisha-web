import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, OTP_PATTERN, PARTNER_KIND_LABEL, PHONE_PATTERN, type PartnerSelection } from '@jansetu/api';
import { Alert, Button, TextField } from '@jansetu/ui';
import { messageOf } from '../errors.ts';
import { useSession, type StaffRole } from '../session.tsx';

const RESEND_SECONDS = 30;
const ROLES: { value: StaffRole; label: string }[] = [
  { value: 'pharmacy', label: 'Pharmacy staff' },
  { value: 'partner', label: 'Lab or clinic staff' },
  { value: 'admin', label: 'Admin' },
];

export function LoginScreen({ notice }: { notice?: string }) {
  const { requestCode, verifyCode, choosePartner } = useSession();
  const [role, setRole] = useState<StaffRole>('pharmacy');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'code' | 'choose'>('phone');
  // Q7: several lab/clinic workspaces for this number. The one-use ticket lives only here, in memory.
  const [selection, setSelection] = useState<PartnerSelection | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  // The number the countdown belongs to: another number can still be used (O1 limits are per destination).
  const [waitFor, setWaitFor] = useState('');
  const waiting = cooldown > 0 && waitFor === phone;
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step]);
  const chooseRef = useRef<HTMLLegendElement>(null);
  useEffect(() => { if (step === 'choose') chooseRef.current?.focus(); }, [step]);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!PHONE_PATTERN.test(phone)) { setFieldError('Enter the 10-digit mobile number.'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      await requestCode(role, { phone });
      setStep('code');
      setOtp('');
      setCooldown(RESEND_SECONDS); setWaitFor(phone);
    } catch (err) {
      setError(messageOf(err));
      // O1: a refused resend waits as long as the server says (the button counts down).
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) { setCooldown(Math.min(err.retryAfter, 24 * 3600)); setWaitFor(phone); }
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!OTP_PATTERN.test(otp)) { setFieldError('Enter the 6-digit code.'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      const choice = await verifyCode(role, { phone }, otp);
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

        {step === 'phone' ? (
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
            <TextField label="Mobile number" inputMode="numeric" autoComplete="tel-national" maxLength={10}
              value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
              error={fieldError} hint="We will send a 6-digit code by SMS." />
            <Button type="submit" busy={busy} disabled={waiting}>{waiting ? `Send code in ${cooldown}s` : 'Send code'}</Button>
          </form>
        ) : step === 'choose' && selection ? (
          <form onSubmit={(e) => void open(e)} className="login-form" noValidate>
            <fieldset className="login-roles" aria-describedby={fieldError ? 'choose-error' : undefined}>
              <legend ref={chooseRef} tabIndex={-1}>Your number belongs to several workspaces. Which one do you want to open?</legend>
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
                onClick={() => { setSelection(null); setStep('phone'); setError(null); setFieldError(null); }}>
                Start again
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={verify} className="login-form" noValidate>
            <p>Enter the code sent to <strong>{phone}</strong>.</p>
            <TextField ref={codeRef} label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} error={fieldError} />
            <Button type="submit" busy={busy}>Verify and sign in</Button>
            <div className="login-actions">
              <Button variant="ghost" disabled={busy || waiting} onClick={() => void send()}>
                {waiting ? `Resend code in ${cooldown}s` : 'Resend code'}
              </Button>
              <Button variant="ghost" disabled={busy}
                onClick={() => { setStep('phone'); setError(null); setFieldError(null); }}>
                Change number
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
