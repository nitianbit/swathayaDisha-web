import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  ApiError, CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE, EMAIL_NOT_REGISTERED_MESSAGE, EMAIL_NOT_REGISTERED_STAFF_MESSAGE, isEmailNotRegistered, maskTarget, MAX_EMAIL, OTP_PATTERN, PARTNER_KIND_LABEL, parseLoginIdentifier,
  targetKey, targetKind, type OtpTarget, type PartnerSelection,
} from '@jansetu/api';
import { Alert, Button, LanguageSwitcher, Parts, TextField, useCooldowns } from '@jansetu/ui';
import { t } from '../i18n/shell/index.ts';
import { BRAND } from '../Shell.tsx';
import { messageOf } from '../errors.ts';
import { useSession, type StaffRole } from '../session.tsx';

const RESEND_SECONDS = 30;
/** The sign-in roles, in this order; each one's words are `login.role.<role>`. */
const ROLES: readonly StaffRole[] = ['pharmacy', 'partner', 'specialist', 'admin'];

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
  const identifierRef = useRef<HTMLInputElement>(null);
  const sentId = useId();
  // WQ11a: focus follows the step (the code field on the code step, the identifier on "Change number or email" and
  // "Start again") and goes to the field an error is about. Asked for by a counter so the same field can be asked again.
  const [focus, setFocus] = useState<{ field: 'identifier' | 'code'; n: number } | null>(null);
  const focusOn = (field: 'identifier' | 'code') => setFocus((f) => ({ field, n: (f?.n ?? 0) + 1 }));
  useEffect(() => {
    if (!focus) return;
    (focus.field === 'code' ? codeRef : identifierRef).current?.focus();
  }, [focus]);
  useEffect(() => { if (step === 'code') focusOn('code'); }, [step]);
  const chooseRef = useRef<HTMLLegendElement>(null);
  useEffect(() => { if (step === 'choose') chooseRef.current?.focus(); }, [step]);

  /** Sends a code to what was typed (first send) or, on the code step, to the same destination again. */
  async function send(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    // The role is captured with the destination (the role choice is frozen while sending).
    const next = step === 'identify' ? (typed ? { role, target: typed } : null) : sent;
    if (!next) { setFieldError(t('login.identifier.missing')); focusOn('identifier'); return; }
    setFieldError(null);
    setBusy(true);
    try {
      await requestCode(next.role, next.target);
      setSent(next);
      setStep('code');
      setOtp('');
      cooldowns.start(targetKey(next.target), RESEND_SECONDS);
    } catch (err) {
      if (isEmailNotRegistered(err)) notRegistered(err, next.role);
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
    if (!OTP_PATTERN.test(otp)) { setFieldError(t('login.code.missing')); focusOn('code'); return; }
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
      if (isEmailNotRegistered(err)) notRegistered(err, sent.role);
      else setError(messageOf(err));
      if (err instanceof ApiError && err.code === 'OTP_ATTEMPTS_EXCEEDED') setOtp(''); // this code is spent: send a new one
      setBusy(false);
    }
  }

  /**
   * WQ9: no account starts from an email: said on the field, with the way on. Doctors and pharmacies have no profile
   * email screen (the team adds their email); others get the server's own words.
   */
  function notRegistered(err: unknown, forRole: StaffRole) {
    setStep('identify');
    setFieldError(forRole === 'specialist' || forRole === 'pharmacy' ? EMAIL_NOT_REGISTERED_STAFF_MESSAGE
      : err instanceof ApiError && err.message ? err.message : EMAIL_NOT_REGISTERED_MESSAGE);
    focusOn('identifier');
  }

  async function open(e: FormEvent) {
    e.preventDefault();
    // Q7: only a lab/clinic sign-in has a workspace choice, opened for the role the code was sent for.
    if (!selection || sent?.role !== 'partner') return;
    setError(null);
    if (!selection.choices.some((c) => c.partnerId === chosen)) { setFieldError(t('login.choose.missing')); chooseRef.current?.focus(); return; }
    setFieldError(null);
    setBusy(true);
    try {
      await choosePartner(selection.ticket, chosen);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SELECTION_EXPIRED') {
        // One use, 5 minutes: a new code is the only way on.
        setSelection(null);
        setStep('code');
        setError(t('login.expired'));
      } else {
        // WQ15b L3: a refusal (the clinic one included) keeps the choice: since r9b the ticket stays valid, so another
        // workspace can be opened from the same list. An older backend answers the next select 401 SELECTION_EXPIRED (above).
        setError(messageOf(err));
      }
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="ws-brand login-brand">{BRAND} <span>{t('shell.workspace')}</span></div>
        <LanguageSwitcher />
        <h1 id="page-title" tabIndex={-1}>{t('login.title')}</h1>
        {notice && <Alert tone="warn">{notice}</Alert>}
        {/* WQ15: a refusal that also ended the session is said once (as the notice). */}
        {error && error !== notice && <Alert>{error}</Alert>}
        {/* WQ15: after the clinic refusal ended the session, the way to another workspace: a lab or clinic sign-in. */}
        {step === 'identify' && notice === CLINIC_DOCTOR_NOT_VERIFIED_MESSAGE && role !== 'partner' && (
          <div className="login-actions">
            <Button variant="secondary" onClick={() => { setRole('partner'); setError(null); focusOn('identifier'); }}>{t('login.chooseAnother')}</Button>
          </div>
        )}

        {step === 'identify' ? (
          <form onSubmit={send} className="login-form" noValidate>
            <fieldset className="login-roles" disabled={busy}>
              <legend>{t('login.roles')}</legend>
              {ROLES.map((r) => (
                <label key={r} className="login-role">
                  <input type="radio" name="role" value={r} checked={role === r}
                    onChange={() => setRole(r)} />
                  {t(`login.role.${r}`)}
                </label>
              ))}
            </fieldset>
            {/* WQ11a: a shared staff PC: the browser must not offer the previous person's number. */}
            <TextField ref={identifierRef} label={t('login.identifier')} type="text" inputMode="text" autoComplete="off" autoCapitalize="none"
              spellCheck={false} maxLength={MAX_EMAIL} value={identifier} onChange={(e) => setIdentifier(e.target.value)}
              error={fieldError} hint={t('login.identifier.hint')} />
            <Button type="submit" busy={busy} disabled={waiting}>{waiting ? t('login.sendIn', { seconds: cooldown }) : t('login.send')}</Button>
          </form>
        ) : step === 'choose' && selection ? (
          <form onSubmit={(e) => void open(e)} className="login-form" noValidate>
            <fieldset className="login-roles" aria-describedby={fieldError ? 'choose-error' : undefined}>
              <legend ref={chooseRef} tabIndex={-1}>
                {target && targetKind(target) === 'email' ? t('login.choose.email') : t('login.choose.number')}
              </legend>
              {selection.choices.map((c) => (
                <label key={c.partnerId} className="login-role">
                  <input type="radio" name="workspace" value={c.partnerId} checked={chosen === c.partnerId}
                    onChange={() => setChosen(c.partnerId)} />
                  <span>
                    <strong>{c.name}</strong>
                    <span className="login-choice-meta">
                      {t(c.solo ? 'login.choice.solo' : 'login.choice', {
                        kind: PARTNER_KIND_LABEL[c.kind] ?? c.kind, role: c.role === 'owner' ? t('login.choice.owner') : t('login.choice.staff'),
                      })}
                    </span>
                  </span>
                </label>
              ))}
              {fieldError && <span id="choose-error" className="j-field__error" role="alert">{fieldError}</span>}
            </fieldset>
            <Button type="submit" busy={busy}>{t('login.open')}</Button>
            <div className="login-actions">
              <Button variant="ghost" disabled={busy}
                onClick={() => { setSelection(null); setStep('identify'); setError(null); setFieldError(null); focusOn('identifier'); }}>
                {t('login.startAgain')}
              </Button>
            </div>
          </form>
        ) : (
          <form onSubmit={verify} className="login-form" noValidate>
            {target && <p id={sentId}><Parts of={t.rich(targetKind(target) === 'email' ? 'login.sent.email' : 'login.sent.phone', { target: <strong>{maskTarget(target)}</strong> })} /></p>}
            <TextField ref={codeRef} label={t('login.code')} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              aria-describedby={target ? sentId : undefined}
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} error={fieldError} />
            <Button type="submit" busy={busy}>{t('login.verify')}</Button>
            <div className="login-actions">
              <Button variant="ghost" disabled={busy || waiting} onClick={() => void send()}>
                {waiting ? t('login.resendIn', { seconds: cooldown }) : t('login.resend')}
              </Button>
              <Button variant="ghost" disabled={busy}
                onClick={() => { setStep('identify'); setError(null); setFieldError(null); focusOn('identifier'); }}>
                {t('login.change')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
