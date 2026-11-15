import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, OTP_PATTERN, PHONE_PATTERN } from '@jansetu/api';
import { Alert, Button, TextField } from '@jansetu/ui';
import { messageOf } from '../common.tsx';
import { useSession } from '../session.tsx';

const RESEND_SECONDS = 30;

export function LoginScreen({ notice }: { notice?: string }) {
  const { requestCode, verifyCode } = useSession();
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
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

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!PHONE_PATTERN.test(phone)) { setFieldError('Enter your 10-digit mobile number.'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      await requestCode(phone);
      setStep('code'); setOtp(''); setCooldown(RESEND_SECONDS); setWaitFor(phone);
    } catch (err) {
      setError(messageOf(err));
      // O1: a refused resend waits as long as the server says (the button counts down).
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) { setCooldown(Math.min(err.retryAfter, 24 * 3600)); setWaitFor(phone); }
    } finally { setBusy(false); }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!OTP_PATTERN.test(otp)) { setFieldError('Enter the 6-digit code.'); return; }
    setFieldError(null);
    setBusy(true);
    try { await verifyCode(phone, otp); } catch (err) {
      setError(messageOf(err)); setBusy(false);
      if (err instanceof ApiError && err.code === 'OTP_ATTEMPTS_EXCEEDED') setOtp(''); // this code is spent: send a new one
    }
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="brand">Jansetu</div>
        <h1 id="page-title" tabIndex={-1}>Sign in</h1>
        <p className="page-sub">Book doctors and lab tests for you and your family.</p>
        {notice && <Alert tone="warn">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        {step === 'phone' ? (
          <form onSubmit={send} className="stack" noValidate>
            <TextField label="Mobile number" inputMode="numeric" autoComplete="tel-national" maxLength={10}
              value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} error={fieldError}
              hint="We will send a 6-digit code by SMS. New here? Your account is created when you sign in." />
            <Button type="submit" busy={busy} disabled={waiting}>{waiting ? `Send code in ${cooldown}s` : 'Send code'}</Button>
          </form>
        ) : (
          <form onSubmit={verify} className="stack" noValidate>
            <p>Enter the code sent to <strong>{phone}</strong>.</p>
            <TextField ref={codeRef} label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} error={fieldError} />
            <Button type="submit" busy={busy}>Verify and sign in</Button>
            <div className="row-between">
              <Button variant="ghost" disabled={busy || waiting} onClick={() => void send()}>
                {waiting ? `Resend code in ${cooldown}s` : 'Resend code'}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => { setStep('phone'); setError(null); setFieldError(null); }}>
                Change number
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
