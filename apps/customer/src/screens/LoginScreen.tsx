import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  ApiError, EMAIL_NOT_REGISTERED_MESSAGE, isEmailNotRegistered, maskTarget, MAX_EMAIL, OTP_PATTERN, parseLoginIdentifier, targetKey, targetKind, type OtpTarget,
} from '@jansetu/api';
import { Alert, Button, TextField, useCooldowns } from '@jansetu/ui';
import { messageOf } from '../common.tsx';
import { useSession } from '../session.tsx';

const RESEND_SECONDS = 30;

export function LoginScreen({ notice }: { notice?: string }) {
  const { requestCode, verifyCode } = useSession();
  // WQ9: a mobile number or an email, as typed. Kept in memory only (never stored, logged or put in a URL).
  const [identifier, setIdentifier] = useState('');
  // The destination the current code was sent to: verify and resend use exactly this one.
  const [target, setTarget] = useState<OtpTarget | null>(null);
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'identify' | 'code'>('identify');
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
  const identifierRef = useRef<HTMLInputElement>(null);
  const sentId = useId();
  // WQ11a: focus follows the step (the code field on the code step, the identifier on "Change number or email") and
  // goes to the field an error is about. Asked for by a counter so the same field can be asked for again.
  const [focus, setFocus] = useState<{ field: 'identifier' | 'code'; n: number } | null>(null);
  const focusOn = (field: 'identifier' | 'code') => setFocus((f) => ({ field, n: (f?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!focus) return;
    (focus.field === 'code' ? codeRef : identifierRef).current?.focus();
  }, [focus]);
  useEffect(() => { if (step === 'code') focusOn('code'); }, [step]);

  /** Sends a code to what was typed (first send) or, on the code step, to the same destination again. */
  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    const to = step === 'identify' ? typed : target;
    if (!to) { setFieldError('Enter your 10-digit mobile number or your email address.'); focusOn('identifier'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      await requestCode(to);
      setTarget(to); setStep('code'); setOtp(''); cooldowns.start(targetKey(to), RESEND_SECONDS);
    } catch (err) {
      if (isEmailNotRegistered(err)) notRegistered(err);
      else setError(messageOf(err));
      // O1: a refused resend waits as long as the server says (the button counts down).
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) cooldowns.start(targetKey(to), Math.min(err.retryAfter, 24 * 3600));
    } finally { setBusy(false); }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!OTP_PATTERN.test(otp)) { setFieldError('Enter the 6-digit code.'); focusOn('code'); return; }
    if (!target) { setStep('identify'); return; }
    setFieldError(null);
    setBusy(true);
    try { await verifyCode(target, otp); } catch (err) {
      if (isEmailNotRegistered(err)) notRegistered(err); else setError(messageOf(err));
      setBusy(false);
      if (err instanceof ApiError && err.code === 'OTP_ATTEMPTS_EXCEEDED') setOtp(''); // this code is spent: send a new one
    }
  }

  /** WQ9: no account starts from an email: said on the field, with the way on (sign in by mobile, add the email). */
  function notRegistered(err: unknown) {
    setStep('identify');
    setFieldError(err instanceof ApiError && err.message ? err.message : EMAIL_NOT_REGISTERED_MESSAGE);
    focusOn('identifier');
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="brand">Jansetu</div>
        <h1 id="page-title" tabIndex={-1}>Sign in</h1>
        <p className="page-sub">Book doctors and lab tests for you and your family.</p>
        {notice && <Alert tone="warn">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        {step === 'identify' ? (
          <form onSubmit={send} className="stack" noValidate>
            {/* WQ11a: a shared family phone: the browser must not offer the previous person's number. */}
            <TextField ref={identifierRef} label="Mobile number or email" type="text" inputMode="text" autoComplete="off" autoCapitalize="none"
              spellCheck={false} maxLength={MAX_EMAIL} value={identifier} onChange={(e) => setIdentifier(e.target.value)} error={fieldError}
              hint="We will send a 6-digit code by SMS or email. New here? Start with your mobile number; an email works once you add it to your profile." />
            <Button type="submit" busy={busy} disabled={waiting}>{waiting ? `Send code in ${cooldown}s` : 'Send code'}</Button>
          </form>
        ) : (
          <form onSubmit={verify} className="stack" noValidate>
            {target && <p id={sentId}>We sent a 6-digit code to your {targetKind(target)} <strong>{maskTarget(target)}</strong>.</p>}
            <TextField ref={codeRef} label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              aria-describedby={target ? sentId : undefined}
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} error={fieldError} />
            <Button type="submit" busy={busy}>Verify and sign in</Button>
            <div className="row-between">
              <Button variant="ghost" disabled={busy || waiting} onClick={() => void send()}>
                {waiting ? `Resend code in ${cooldown}s` : 'Resend code'}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => { setStep('identify'); setError(null); setFieldError(null); focusOn('identifier'); }}>
                Change number or email
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
