import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  EMAIL_IN_USE_MESSAGE, EMAIL_PATTERN, GSTIN_PATTERN, INVOICE_PREFIX_PATTERN, isEmailInUse, MAX_EMAIL, MAX_NAME, memberEmail, PAN_PATTERN,
  PARTNER_PHONE_PATTERN, partnerAdminApi,
  TAX_REGIME_LABEL, type NewPartner, type Partner, type PartnerKind, type TaxRegime,
} from '@jansetu/api';
import { Alert, Button, ErrorState, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/admin/index.ts';
import { afterFailure, beginAttempt, newRequestKey, ownsKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';

const REGIMES: TaxRegime[] = ['unregistered', 'regular', 'composition'];

interface Draft {
  kind: PartnerKind; name: string; legalName: string; gstin: string; pan: string; contactPhone: string; contactEmail: string;
  taxRegime: TaxRegime; prefix: string; solo: boolean; ownerName: string; ownerPhone: string;
  /** WQ9: optional; the owner can then sign in with it. */
  ownerEmail: string;
}

/** Checks against `createPartnerSchema` and builds the request (optional fields only when filled in). */
export function newPartnerBody(d: Draft): { body: NewPartner; errors: Record<string, string> } {
  const e: Record<string, string> = {};
  const trim = (s: string) => s.trim();
  const up = (s: string) => s.trim().toUpperCase();
  const tooLong = () => t('newPartner.tooLong', { max: MAX_NAME });
  if (!trim(d.name)) e.name = t('newPartner.nameMissing');
  else if (trim(d.name).length > MAX_NAME) e.name = tooLong();
  if (trim(d.legalName).length > MAX_NAME) e.legalName = tooLong();
  if (trim(d.gstin) && !GSTIN_PATTERN.test(up(d.gstin))) e.gstin = t('partners.gstinInvalid');
  if (trim(d.pan) && !PAN_PATTERN.test(up(d.pan))) e.pan = t('partners.panInvalid');
  if (!PARTNER_PHONE_PATTERN.test(d.contactPhone)) e.contactPhone = t('newPartner.contactPhoneInvalid');
  if (trim(d.contactEmail) && !EMAIL_PATTERN.test(trim(d.contactEmail))) e.contactEmail = t('newPartner.emailInvalid');
  if (!INVOICE_PREFIX_PATTERN.test(up(d.prefix))) e.prefix = t('partners.prefixInvalid');
  if (!trim(d.ownerName)) e.ownerName = t('newPartner.ownerNameMissing');
  else if (trim(d.ownerName).length > MAX_NAME) e.ownerName = tooLong();
  if (!PARTNER_PHONE_PATTERN.test(d.ownerPhone)) e.ownerPhone = t('newPartner.ownerPhoneInvalid');
  const ownerEmail = memberEmail(d.ownerEmail ?? '');
  if (ownerEmail === null) e.ownerEmail = t('newPartner.ownerEmailInvalid');
  const body: NewPartner = {
    kind: d.kind, name: trim(d.name), contactPhone: d.contactPhone, taxRegime: d.taxRegime, invoiceSeriesPrefix: up(d.prefix),
    firstOwner: { name: trim(d.ownerName), phone: d.ownerPhone, ...(ownerEmail ? { email: ownerEmail } : {}) },
    ...(trim(d.legalName) ? { legalName: trim(d.legalName) } : {}),
    ...(trim(d.gstin) ? { gstin: up(d.gstin) } : {}),
    ...(trim(d.pan) ? { pan: up(d.pan) } : {}),
    ...(trim(d.contactEmail) ? { contactEmail: trim(d.contactEmail) } : {}),
    ...(d.kind === 'clinic' && d.solo ? { solo: true } : {}),
  };
  return { body, errors: e };
}

/** Session memory slot of an unconfirmed creation (one at a time per admin). */
const PENDING_SLOT = 'admin-partner-create';
type Pending = PendingOp<{ body: NewPartner; draft: Draft }>;

const EMPTY: Draft = {
  kind: 'lab', name: '', legalName: '', gstin: '', pan: '', contactPhone: '', contactEmail: '', taxRegime: 'unregistered', prefix: '',
  solo: false, ownerName: '', ownerPhone: '', ownerEmail: '',
};

/**
 * Admin: create a lab or clinic with its first owner (it starts waiting for verification). Q8: creation is exactly
 * once per request key. A key is made per submitted form and kept, with the exact request, until the answer is known:
 * after a lost answer the form is locked and "Send again" resends the same key and content (the server answers with
 * the partner it already made). Q10: the only other way out is giving the create up on the server (`abandon`): then
 * that key can never create a partner. After a reload only the key is known: it is looked up, never guessed from the
 * list.
 */
export function NewPartnerScreen() {
  const { api, memory } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const admin = partnerAdminApi(api);
  const [pending, setPendingState] = useState<Pending | undefined>(() => memory.get<Pending>(PENDING_SLOT));
  const [d, setD] = useState<Draft>(() => memory.get<Pending>(PENDING_SLOT)?.body?.draft ?? EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [found, setFound] = useState<Partner | null>(null);
  const [busy, setBusy] = useState(false);
  // This page is still on screen (a late answer for a page the admin left must not move them).
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const locked = !!pending;
  const text = (k: keyof Draft, digits = false) => ({
    value: d[k] as string, error: errors[k], disabled: locked,
    onChange: (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: digits ? e.target.value.replace(/\D/g, '') : e.target.value })),
  });
  const setPending = (p: Pending | undefined) => {
    if (p) memory.set(PENDING_SLOT, p); else memory.delete(PENDING_SLOT);
    setPendingState(p);
  };
  /**
   * WQ11b: an answer about the KEY itself (the give-up's `used`/`abandoned`, the by-key lookup) acts while this page is on
   * screen and no other creation is stored. After leaving mid-send and coming back, the first page's late answer may have
   * settled and removed the stored creation while this page still shows it: the server's word on the key settles it here.
   */
  const ownsTheKey = (p: Pending) => live.current && ownsKey(memory.get<Pending>(PENDING_SLOT), p.requestKey);
  /** Ends the stored creation with this key, and only it. */
  const settle = (requestKey: string) => {
    resolveStored(memory, PENDING_SLOT, requestKey);
    if (live.current) setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
  };
  const open = async (partnerId: string) => {
    await queryClient.invalidateQueries({ queryKey: ['admin-partners'] });
    if (live.current) void navigate(`/admin/partners/${partnerId}`); // only while this page is still the one on screen
  };

  // After a reload: what did the stored key produce? (A body-less marker: nothing can be resent.)
  const restoredKey = pending?.restored ? pending.requestKey : null;
  const lookup = useQuery({
    queryKey: ['admin-partners', 'by-key', restoredKey],
    queryFn: () => admin.createdByKey(restoredKey!),
    enabled: !!restoredKey,
  });
  useEffect(() => {
    // Only for the restored creation this page is showing (a cached answer for another key or a newer state is ignored).
    if (restoredKey && lookup.data && pending?.requestKey === restoredKey && ownsTheKey(pending)) {
      setFound(lookup.data.partner);
      settle(restoredKey);
    }
  }, [restoredKey, lookup.data, pending]);

  /** Sends exactly `p` (same key, same content). Only success, or a definite refusal of its first attempt, ends it. */
  async function send(p: Pending) {
    const attempt = beginAttempt(p); // stored before sending: leaving and coming back sees it as possibly running
    setPending(attempt);
    setBusy(true);
    setError(null); setNotice(null);
    try {
      const created = await admin.create(attempt.body.body, attempt.requestKey);
      // A newer attempt (or a give-up) owns the outcome now; this older answer changes nothing.
      if (!stillCurrent(memory.get<Pending>(PENDING_SLOT), attempt)) return;
      settle(attempt.requestKey);
      await open(created.partner._id);
    } catch (err) {
      if (!stillCurrent(memory.get<Pending>(PENDING_SLOT), attempt)) return;
      const next = afterFailure(attempt, err, messageOf(err));
      setPending(next ?? undefined);
      // Refused, nothing created: the form unlocks with what was typed (WQ9: an owner email in use is shown on its field).
      if (!next && live.current) { if (isEmailInUse(err)) setErrors({ ownerEmail: EMAIL_IN_USE_MESSAGE }); else setError(messageOf(err)); }
    } finally {
      if (live.current) setBusy(false);
    }
  }

  /** Q10: makes sure the key can never create a partner ('abandoned'), or learns that it did ('used'). */
  async function giveUp(p: Pending) {
    setBusy(true);
    setError(null); setNotice(null);
    try {
      const r = await admin.abandonCreate(p.requestKey);
      // Left page, or another creation stored meanwhile: this answer settles and opens nothing.
      if (!ownsTheKey(p)) return;
      if (r.state === 'used') {
        settle(p.requestKey);
        if (r.partner) { await open(r.partner._id); return; }
        setNotice(t('newPartner.alreadyCreated'));
        return;
      }
      settle(p.requestKey);
      if (p.restored) setD(EMPTY);
      setNotice(t('newPartner.givenUp'));
    } catch (err) {
      if (ownsTheKey(p)) setError(messageOf(err));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return; // resolve the unconfirmed one first
    const { body, errors: errs } = newPartnerBody(d);
    setErrors(errs); setError(null); setNotice(null);
    if (Object.keys(errs).length) return;
    void send(startOp(newRequestKey(), { body, draft: d }));
  }

  return (
    <>
      <Link className="ws-back" to="/admin/partners"><ArrowLeft size={16} aria-hidden="true" /> {t('common.backToPartners')}</Link>
      <PageHeading title={t('newPartner.title')}>{t('newPartner.intro')}</PageHeading>
      {found && (
        <section className="ws-section" aria-labelledby="found-h">
          <h2 id="found-h">{t('newPartner.foundTitle', { name: found.name })}</h2>
          <p className="ws-muted">{t('newPartner.foundBody')}</p>
          <div className="ws-actions">
            <Link className="j-btn j-btn--primary" to={`/admin/partners/${found._id}`}>{t('newPartner.foundOpen', { name: found.name })}</Link>
            <Button variant="secondary" onClick={() => setFound(null)}>{t('newPartner.addAnother')}</Button>
          </div>
        </section>
      )}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {pending?.restored ? (
        <section className="ws-section" aria-labelledby="unconfirmed-h">
          <h2 id="unconfirmed-h">{t('newPartner.restoredTitle')}</h2>
          {lookup.isPending ? <Loading label={t('newPartner.restoredChecking')} />
            : lookup.isError ? <ErrorState message={messageOf(lookup.error)} onRetry={() => void lookup.refetch()} />
            : (
              <>
                <Alert tone="warn">{t('newPartner.restoredBody')}</Alert>
                {error && <Alert>{error}</Alert>}
                <div className="ws-actions">
                  <Button busy={busy} onClick={() => void giveUp(pending)}>{t('newPartner.giveUp')}</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void lookup.refetch()}>{t('newPartner.checkAgain')}</Button>
                </div>
              </>
            )}
        </section>
      ) : !found && (
      <form className="rx-form ws-section" noValidate onSubmit={submit}>
        {pending && (
          <div className="confirm" role="group" aria-label={t('newPartner.pendingLabel')}>
            <Alert tone="warn">
              {pending.error
                ? t('newPartner.pendingBodyWithError', { name: pending.body.body.name, error: pending.error })
                : t('newPartner.pendingBody', { name: pending.body.body.name })}
            </Alert>
            {error && <Alert>{error}</Alert>}
            <div className="confirm-actions">
              <Button busy={busy} onClick={() => void send(pending)}>{t('newPartner.sendAgain')}</Button>
              <Button variant="secondary" disabled={busy} onClick={() => void giveUp(pending)}>{t('newPartner.giveUp')}</Button>
            </div>
          </div>
        )}
        <fieldset className="ws-checks" disabled={locked}>
          <legend>{t('common.type')}</legend>
          <label className="ws-check"><input type="radio" name="kind" checked={d.kind === 'lab'} onChange={() => setD((x) => ({ ...x, kind: 'lab' }))} /> {t('newPartner.kindLab')}</label>
          <label className="ws-check"><input type="radio" name="kind" checked={d.kind === 'clinic'} onChange={() => setD((x) => ({ ...x, kind: 'clinic' }))} /> {t('newPartner.kindClinic')}</label>
          {d.kind === 'clinic' && (
            <label className="ws-check">
              <input type="checkbox" checked={d.solo} onChange={(e) => setD((x) => ({ ...x, solo: e.target.checked }))} /> {t('newPartner.solo')}
            </label>
          )}
        </fieldset>
        <div className="rx-form-row">
          <TextField label={t('newPartner.displayName')} maxLength={MAX_NAME} {...text('name')} />
          <TextField label={t('newPartner.legalName')} maxLength={MAX_NAME} {...text('legalName')} />
        </div>
        <div className="rx-form-row">
          <TextField label={t('newPartner.contactPhone')} inputMode="numeric" maxLength={10} {...text('contactPhone', true)} />
          <TextField label={t('newPartner.contactEmail')} type="email" {...text('contactEmail')} />
        </div>
        <div className="rx-form-row">
          <TextField label={t('newPartner.gstin')} maxLength={15} {...text('gstin')} />
          <TextField label={t('newPartner.pan')} maxLength={10} {...text('pan')} />
          <div className="j-field">
            <label htmlFor="np-tax">{t('partners.taxLabel')}</label>
            <select id="np-tax" value={d.taxRegime} disabled={locked} onChange={(e) => setD((x) => ({ ...x, taxRegime: e.target.value as TaxRegime }))}>
              {REGIMES.map((r) => <option key={r} value={r}>{TAX_REGIME_LABEL[r]}</option>)}
            </select>
          </div>
          <TextField label={t('partners.invoicePrefix')} maxLength={6} hint={t('newPartner.prefixHint')} {...text('prefix')} />
        </div>
        <h2>{t('newPartner.firstOwner')}</h2>
        <div className="rx-form-row">
          <TextField label={t('newPartner.ownerName')} maxLength={MAX_NAME} {...text('ownerName')} />
          <TextField label={t('newPartner.ownerPhone')} inputMode="numeric" maxLength={10} {...text('ownerPhone', true)} />
          <TextField label={t('newPartner.ownerEmail')} type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL}
            hint={t('newPartner.ownerEmailHint')} {...text('ownerEmail')} />
        </div>
        {!pending && error && <Alert>{error}</Alert>}
        {!locked && <div><Button type="submit" busy={busy}>{t('newPartner.create')}</Button></div>}
      </form>
      )}
    </>
  );
}
