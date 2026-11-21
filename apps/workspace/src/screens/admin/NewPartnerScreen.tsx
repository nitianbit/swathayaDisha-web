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
  const t = (s: string) => s.trim();
  const up = (s: string) => s.trim().toUpperCase();
  if (!t(d.name)) e.name = 'Enter the name customers will see.';
  else if (t(d.name).length > MAX_NAME) e.name = `Use at most ${MAX_NAME} characters.`;
  if (t(d.legalName).length > MAX_NAME) e.legalName = `Use at most ${MAX_NAME} characters.`;
  if (t(d.gstin) && !GSTIN_PATTERN.test(up(d.gstin))) e.gstin = 'Enter a valid 15-character GSTIN.';
  if (t(d.pan) && !PAN_PATTERN.test(up(d.pan))) e.pan = 'Enter a valid 10-character PAN.';
  if (!PARTNER_PHONE_PATTERN.test(d.contactPhone)) e.contactPhone = 'Enter the 10-digit contact number.';
  if (t(d.contactEmail) && !EMAIL_PATTERN.test(t(d.contactEmail))) e.contactEmail = 'Enter a valid email address.';
  if (!INVOICE_PREFIX_PATTERN.test(up(d.prefix))) e.prefix = 'Use 1 to 6 letters or digits.';
  if (!t(d.ownerName)) e.ownerName = 'Enter the owner’s name.';
  else if (t(d.ownerName).length > MAX_NAME) e.ownerName = `Use at most ${MAX_NAME} characters.`;
  if (!PARTNER_PHONE_PATTERN.test(d.ownerPhone)) e.ownerPhone = 'Enter the owner’s 10-digit mobile number.';
  const ownerEmail = memberEmail(d.ownerEmail ?? '');
  if (ownerEmail === null) e.ownerEmail = 'Enter a valid email address, or leave it empty.';
  const body: NewPartner = {
    kind: d.kind, name: t(d.name), contactPhone: d.contactPhone, taxRegime: d.taxRegime, invoiceSeriesPrefix: up(d.prefix),
    firstOwner: { name: t(d.ownerName), phone: d.ownerPhone, ...(ownerEmail ? { email: ownerEmail } : {}) },
    ...(t(d.legalName) ? { legalName: t(d.legalName) } : {}),
    ...(t(d.gstin) ? { gstin: up(d.gstin) } : {}),
    ...(t(d.pan) ? { pan: up(d.pan) } : {}),
    ...(t(d.contactEmail) ? { contactEmail: t(d.contactEmail) } : {}),
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
        setNotice('It had already been created. Find it in the list.');
        return;
      }
      settle(p.requestKey);
      if (p.restored) setD(EMPTY);
      setNotice('Given up: nothing was created and that request can never create a partner. You can create it again.');
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
      <Link className="ws-back" to="/admin/partners"><ArrowLeft size={16} aria-hidden="true" /> Back to labs and clinics</Link>
      <PageHeading title="Add a lab or clinic">It starts waiting for verification; its owner can use the workspace once it is verified.</PageHeading>
      {found && (
        <section className="ws-section" aria-labelledby="found-h">
          <h2 id="found-h">{found.name} was created</h2>
          <p className="ws-muted">The creation that was unconfirmed before the page reloaded did go through.</p>
          <div className="ws-actions">
            <Link className="j-btn j-btn--primary" to={`/admin/partners/${found._id}`}>Open {found.name}</Link>
            <Button variant="secondary" onClick={() => setFound(null)}>Add another</Button>
          </div>
        </section>
      )}
      {notice && <Alert tone="ok">{notice}</Alert>}
      {pending?.restored ? (
        <section className="ws-section" aria-labelledby="unconfirmed-h">
          <h2 id="unconfirmed-h">An unconfirmed creation</h2>
          {lookup.isPending ? <Loading label="Checking whether it was created…" />
            : lookup.isError ? <ErrorState message={messageOf(lookup.error)} onRetry={() => void lookup.refetch()} />
            : (
              <>
                <Alert tone="warn">
                  Before the page reloaded, a lab or clinic was being created and its answer never arrived. Nothing has
                  been created with it so far, but the request could still arrive. Give it up so it never can, then
                  start again. Its details are not kept on this device.
                </Alert>
                {error && <Alert>{error}</Alert>}
                <div className="ws-actions">
                  <Button busy={busy} onClick={() => void giveUp(pending)}>Give up this create</Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void lookup.refetch()}>Check again</Button>
                </div>
              </>
            )}
        </section>
      ) : !found && (
      <form className="rx-form ws-section" noValidate onSubmit={submit}>
        {pending && (
          <div className="confirm" role="group" aria-label="Unconfirmed creation">
            <Alert tone="warn">
              {`We could not confirm whether ${pending.body.body.name} was created${pending.error ? ` (${pending.error})` : ''}. `}
              Send again to find out: it sends the same request, so it can never create a second one. Or give it up: then
              it can never be created, and you can change the form. The form stays locked until one of these is done.
            </Alert>
            {error && <Alert>{error}</Alert>}
            <div className="confirm-actions">
              <Button busy={busy} onClick={() => void send(pending)}>Send again</Button>
              <Button variant="secondary" disabled={busy} onClick={() => void giveUp(pending)}>Give up this create</Button>
            </div>
          </div>
        )}
        <fieldset className="ws-checks" disabled={locked}>
          <legend>Type</legend>
          <label className="ws-check"><input type="radio" name="kind" checked={d.kind === 'lab'} onChange={() => setD((x) => ({ ...x, kind: 'lab' }))} /> Lab</label>
          <label className="ws-check"><input type="radio" name="kind" checked={d.kind === 'clinic'} onChange={() => setD((x) => ({ ...x, kind: 'clinic' }))} /> Clinic</label>
          {d.kind === 'clinic' && (
            <label className="ws-check">
              <input type="checkbox" checked={d.solo} onChange={(e) => setD((x) => ({ ...x, solo: e.target.checked }))} /> Single-doctor practice
            </label>
          )}
        </fieldset>
        <div className="rx-form-row">
          <TextField label="Display name" maxLength={MAX_NAME} {...text('name')} />
          <TextField label="Legal name (optional)" maxLength={MAX_NAME} {...text('legalName')} />
        </div>
        <div className="rx-form-row">
          <TextField label="Contact phone" inputMode="numeric" maxLength={10} {...text('contactPhone', true)} />
          <TextField label="Contact email (optional)" type="email" {...text('contactEmail')} />
        </div>
        <div className="rx-form-row">
          <TextField label="GSTIN (optional)" maxLength={15} {...text('gstin')} />
          <TextField label="PAN (optional)" maxLength={10} {...text('pan')} />
          <div className="j-field">
            <label htmlFor="np-tax">Tax</label>
            <select id="np-tax" value={d.taxRegime} disabled={locked} onChange={(e) => setD((x) => ({ ...x, taxRegime: e.target.value as TaxRegime }))}>
              {REGIMES.map((r) => <option key={r} value={r}>{TAX_REGIME_LABEL[r]}</option>)}
            </select>
          </div>
          <TextField label="Invoice prefix" maxLength={6} hint="1 to 6 letters or digits, printed on every invoice" {...text('prefix')} />
        </div>
        <h2>First owner</h2>
        <div className="rx-form-row">
          <TextField label="Owner name" maxLength={MAX_NAME} {...text('ownerName')} />
          <TextField label="Owner mobile number" inputMode="numeric" maxLength={10} {...text('ownerPhone', true)} />
          <TextField label="Owner email (optional)" type="email" inputMode="email" autoCapitalize="none" spellCheck={false} maxLength={MAX_EMAIL}
            hint="The owner can sign in with this email too" {...text('ownerEmail')} />
        </div>
        {!pending && error && <Alert>{error}</Alert>}
        {!locked && <div><Button type="submit" busy={busy}>Create</Button></div>}
      </form>
      )}
    </>
  );
}
