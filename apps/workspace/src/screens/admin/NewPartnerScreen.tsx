import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  EMAIL_PATTERN, GSTIN_PATTERN, INVOICE_PREFIX_PATTERN, MAX_NAME, PAN_PATTERN, PARTNER_PHONE_PATTERN, partnerAdminApi,
  TAX_REGIME_LABEL, type NewPartner, type PartnerKind, type TaxRegime,
} from '@jansetu/api';
import { Alert, Button, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { afterFailure, beginAttempt, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';

const REGIMES: TaxRegime[] = ['unregistered', 'regular', 'composition'];

interface Draft {
  kind: PartnerKind; name: string; legalName: string; gstin: string; pan: string; contactPhone: string; contactEmail: string;
  taxRegime: TaxRegime; prefix: string; solo: boolean; ownerName: string; ownerPhone: string;
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
  const body: NewPartner = {
    kind: d.kind, name: t(d.name), contactPhone: d.contactPhone, taxRegime: d.taxRegime, invoiceSeriesPrefix: up(d.prefix),
    firstOwner: { name: t(d.ownerName), phone: d.ownerPhone },
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
  solo: false, ownerName: '', ownerPhone: '',
};

/**
 * Admin: create a lab or clinic with its first owner (it starts waiting for verification). Q8: creation is exactly
 * once per request key. A key is made per submitted form and kept, with the exact request, until the answer is known:
 * after a lost answer the form is locked and "Send again" resends the same key and content (the server answers with
 * the partner it already made), so a retry can never create a second partner.
 */
export function NewPartnerScreen() {
  const { api, memory } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPendingState] = useState<Pending | undefined>(() => memory.get<Pending>(PENDING_SLOT));
  const [d, setD] = useState<Draft>(() => memory.get<Pending>(PENDING_SLOT)?.body?.draft ?? EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = !!pending;
  const text = (k: keyof Draft, digits = false) => ({
    value: d[k] as string, error: errors[k], disabled: locked,
    onChange: (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: digits ? e.target.value.replace(/\D/g, '') : e.target.value })),
  });
  const setPending = (p: Pending | undefined) => {
    if (p) memory.set(PENDING_SLOT, p); else memory.delete(PENDING_SLOT);
    setPendingState(p);
  };

  /** Sends exactly `p` (same key, same content). Only success, or a definite refusal of its first attempt, ends it. */
  async function send(p: Pending) {
    const attempt = beginAttempt(p); // stored before sending: leaving and coming back sees it as possibly running
    setPending(attempt);
    setBusy(true);
    setError(null);
    try {
      const created = await partnerAdminApi(api).create(attempt.body.body, attempt.requestKey);
      resolveStored(memory, PENDING_SLOT, attempt.requestKey);
      await queryClient.invalidateQueries({ queryKey: ['admin-partners'] });
      void navigate(`/admin/partners/${created.partner._id}`);
    } catch (err) {
      if (!stillCurrent(memory.get<Pending>(PENDING_SLOT), attempt)) return; // a newer attempt owns the state
      const next = afterFailure(attempt, err, messageOf(err));
      setPending(next ?? undefined);
      if (!next) setError(messageOf(err)); // refused, nothing created: the form unlocks with what was typed
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return; // resolve the unconfirmed one first
    const { body, errors: errs } = newPartnerBody(d);
    setErrors(errs); setError(null);
    if (Object.keys(errs).length) return;
    void send(startOp(newRequestKey(), { body, draft: d }));
  }

  return (
    <>
      <Link className="ws-back" to="/admin/partners"><ArrowLeft size={16} aria-hidden="true" /> Back to labs and clinics</Link>
      <PageHeading title="Add a lab or clinic">It starts waiting for verification; its owner can use the workspace once it is verified.</PageHeading>
      {pending?.restored ? (
        <section className="ws-section" aria-labelledby="unconfirmed-h">
          <h2 id="unconfirmed-h">A lab or clinic may already have been created</h2>
          <Alert tone="warn">
            Before the page reloaded, a new lab or clinic was being created and its answer never arrived. Its details are
            not kept on this device, so it cannot be sent again. Look for it in the list before adding it again.
          </Alert>
          <div className="ws-actions">
            <Link className="j-btn j-btn--primary" to="/admin/partners">Look in the list</Link>
            <Button variant="secondary" onClick={() => { setPending(undefined); setD(EMPTY); }}>It is not in the list: start again</Button>
          </div>
        </section>
      ) : (
      <form className="rx-form ws-section" noValidate onSubmit={submit}>
        {pending && (
          <div className="confirm" role="group" aria-label="Unconfirmed creation">
            <Alert tone="warn">
              {`We could not confirm whether ${pending.body.body.name} was created${pending.error ? ` (${pending.error})` : ''}. `}
              Send again to find out: it sends the same request, so it can never create a second one. The form stays
              locked until then.
            </Alert>
            <div className="confirm-actions">
              <Button busy={busy} onClick={() => void send(pending)}>Send again</Button>
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
        </div>
        {error && <Alert>{error}</Alert>}
        {!locked && <div><Button type="submit" busy={busy}>Create</Button></div>}
      </form>
      )}
    </>
  );
}
