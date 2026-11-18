import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  canEditProfile, EMAIL_PATTERN, MAX_NAME, PARTNER_KIND_LABEL, PARTNER_PHONE_PATTERN, TAX_REGIME_LABEL, VERIFICATION_LABEL,
  type MyPartnerUpdate, type Partner,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { dirtyKeys, isRecordChanged, RECORD_CHANGED_MESSAGE, staleMessage, useDraft, type DraftState } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { NoSuchPartner, PartnerPageHeading, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

type Fields = { name: string; legalName: string; contactPhone: string; contactEmail: string };
const fieldsOf = (p: Partner): Fields => ({
  name: p.name ?? '', legalName: p.legalName ?? '', contactPhone: p.contact?.phone ?? '', contactEmail: p.contact?.email ?? '',
});
const FIELD_LABEL: Record<keyof Fields, string> = { name: 'display name', legalName: 'legal name', contactPhone: 'contact phone', contactEmail: 'contact email' };

/** Checks the changed fields against `updateMyPartnerSchema` (the backend cannot clear a field). */
export function profileChanges(s: DraftState<Fields>): { changes: MyPartnerUpdate; errors: Partial<Record<keyof Fields, string>> } {
  const errors: Partial<Record<keyof Fields, string>> = {};
  const changes: MyPartnerUpdate = {};
  for (const key of dirtyKeys(s)) {
    const value = s.draft[key].trim();
    if (value === s.base[key].trim()) continue;
    if (!value) { errors[key] = s.base[key] ? 'This cannot be removed here. Enter a new value.' : 'Enter a value.'; continue; }
    if ((key === 'name' || key === 'legalName') && value.length > MAX_NAME) { errors[key] = `Use at most ${MAX_NAME} characters.`; continue; }
    if (key === 'contactPhone' && !PARTNER_PHONE_PATTERN.test(value)) { errors[key] = 'Enter the 10-digit mobile number.'; continue; }
    if (key === 'contactEmail' && !EMAIL_PATTERN.test(value)) { errors[key] = 'Enter a valid email address.'; continue; }
    changes[key] = value;
  }
  return { changes, errors };
}

/** Partner profile: owners (and admins) change the contact details (`PUT /me`, Q8 owner-only); the rest is Jansetu's. */
export function ProfileScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: nothing typed for one partner can be sent to another (admins switch partners by URL).
  return <Profile key={ctx.key.join(':')} ctx={ctx} />;
}

function Profile({ ctx }: { ctx: ScopeContext }) {
  const me = useWorkspacePartner(ctx);
  const p = me.data;
  return (
    <>
      <PartnerPageHeading ctx={ctx} title="Profile" partnerName={p?.name}>How your organisation appears to customers and on invoices.</PartnerPageHeading>
      {me.isPending ? <Loading label="Loading profile…" />
        : me.isError ? <ErrorState message={messageOf(me.error)} onRetry={() => void me.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="org-h">
              <h2 id="org-h">{p!.name}</h2>
              <dl className="ws-dl">
                <dt>Type</dt><dd>{PARTNER_KIND_LABEL[p!.kind] ?? p!.kind}{p!.solo ? ' (single-doctor practice)' : ''}</dd>
                <dt>Status</dt>
                <dd>
                  <Badge tone={p!.verification?.state === 'verified' ? 'ok' : p!.verification?.state === 'suspended' ? 'danger' : 'warn'}>
                    {VERIFICATION_LABEL[p!.verification?.state] ?? p!.verification?.state ?? '—'}
                  </Badge>
                </dd>
                {p!.verification?.verifiedAt && <><dt>Verified</dt><dd>{formatDateTime(p!.verification.verifiedAt)}</dd></>}
                <dt>GSTIN</dt><dd>{p!.gstin || '—'}</dd>
                <dt>PAN</dt><dd>{p!.pan || '—'}</dd>
                <dt>Tax</dt><dd>{TAX_REGIME_LABEL[p!.taxRegime] ?? p!.taxRegime ?? '—'}</dd>
                <dt>Invoice prefix</dt><dd>{p!.invoiceSeries?.prefix || '—'}</dd>
                <dt>Owners</dt><dd>{p!.activeOwnerCount}</dd>
                {!canEditProfile(ctx.actor) && <>
                  <dt>Legal name</dt><dd>{p!.legalName || '—'}</dd>
                  <dt>Contact</dt><dd>{p!.contact?.phone}{p!.contact?.email ? ` · ${p!.contact.email}` : ''}</dd>
                </>}
              </dl>
              <p className="ws-muted">
                {canEditProfile(ctx.actor) ? 'Registration and tax details are changed by Jansetu.' : 'Only an owner can change these details.'}
              </p>
            </section>
            {canEditProfile(ctx.actor) && <ContactForm ctx={ctx} partner={p!} />}
            <CounterPayments key={p!.updatedAt ?? ''} ctx={ctx} partner={p!} />
          </>
        )}
    </>
  );
}

function ContactForm({ ctx, partner }: { ctx: ScopeContext; partner: Partner }) {
  const queryClient = useQueryClient();
  const d = useDraft(() => fieldsOf(partner));
  const [errors, setErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { rebaseTo } = d;
  // A newer server value (refetch) moves untouched fields along; a field also changed here is flagged for review.
  useEffect(() => {
    const c = rebaseTo(fieldsOf(partner));
    if (c.length) setStale(staleMessage(c.map((k) => FIELD_LABEL[k])));
  }, [partner, rebaseTo]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setStale(null);
    const first = profileChanges(d.current());
    setErrors(first.errors);
    if (Object.keys(first.errors).length) return;
    if (Object.keys(first.changes).length === 0) { setNotice('Nothing has changed.'); return; }
    setBusy(true);
    try {
      // The edit is checked against what is saved now, not only against the page's last read.
      const fresh = await ctx.api.me();
      queryClient.setQueryData([...ctx.key, 'me'], fresh);
      const conflicts = rebaseTo(fieldsOf(fresh));
      if (conflicts.length) { setStale(staleMessage(conflicts.map((k) => FIELD_LABEL[k]))); return; }
      const { changes } = profileChanges(d.current());
      if (Object.keys(changes).length === 0) { setNotice('Nothing has changed.'); return; }
      try {
        // Q10: refused (409 RECORD_CHANGED) if the profile moved after the read above.
        const updated = await ctx.api.updateMe(changes, fresh.updatedAt);
        queryClient.setQueryData([...ctx.key, 'me'], updated);
        setNotice('Saved.');
      } catch (err) {
        if (!isRecordChanged(err)) throw err;
        const latest = await ctx.api.me();
        queryClient.setQueryData([...ctx.key, 'me'], latest);
        const c = rebaseTo(fieldsOf(latest));
        setStale(c.length ? staleMessage(c.map((k) => FIELD_LABEL[k])) : RECORD_CHANGED_MESSAGE);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const f = d.draft;
  const set = (key: keyof Fields) => (e: { target: { value: string } }) => d.set(key, e.target.value);
  return (
    <section className="ws-section" aria-labelledby="edit-h">
      <h2 id="edit-h">Contact details</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <fieldset className="ws-frozen" disabled={busy}>
        <div className="rx-form-row">
          <TextField label="Display name" value={f.name} onChange={set('name')} error={errors.name} maxLength={MAX_NAME} autoComplete="organization" />
          <TextField label="Legal name" value={f.legalName} onChange={set('legalName')} error={errors.legalName} maxLength={MAX_NAME} />
        </div>
        <div className="rx-form-row">
          <TextField label="Contact phone" inputMode="numeric" maxLength={10} value={f.contactPhone}
            onChange={(e) => d.set('contactPhone', e.target.value.replace(/\D/g, ''))} error={errors.contactPhone} />
          <TextField label="Contact email" type="email" value={f.contactEmail} onChange={set('contactEmail')} error={errors.contactEmail} autoComplete="email" />
        </div>
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <Button type="submit" busy={busy}>Save</Button>
      </form>
    </section>
  );
}

/**
 * Q14 `allowPartPayments` (default off): whether an in-house bill may be paid in several payments. Owners (and admins as
 * owner) change it; the choice is checked against what is saved right before sending (another change meanwhile resets it
 * for review) and the write names that version (`expectedUpdatedAt`, 409 RECORD_CHANGED).
 */
function CounterPayments({ ctx, partner }: { ctx: ScopeContext; partner: Partner }) {
  const queryClient = useQueryClient();
  const base = partner.allowPartPayments === true;
  const [on, setOn] = useState(base);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = canEditProfile(ctx.actor);
  const words = (v: boolean) => (v
    ? 'Part payments are allowed: a bill can be paid in several payments, any amount up to what is due each time.'
    : 'Full payment only: each payment settles everything still due (it may be split across methods, such as cash and UPI).');

  async function save(e: FormEvent) {
    e.preventDefault();
    setNotice(null); setError(null);
    if (on === base) { setNotice('Nothing has changed.'); return; }
    setBusy(true);
    try {
      const fresh = await ctx.api.me();
      if ((fresh.allowPartPayments === true) !== base) {
        queryClient.setQueryData([...ctx.key, 'me'], fresh);
        setError('Someone else changed this setting while you were editing. The page now shows what is saved; choose again if needed.');
        return;
      }
      try {
        const updated = await ctx.api.updateMe({ allowPartPayments: on }, fresh.updatedAt);
        queryClient.setQueryData([...ctx.key, 'me'], updated);
      } catch (err) {
        if (!isRecordChanged(err)) throw err;
        queryClient.setQueryData([...ctx.key, 'me'], await ctx.api.me());
        setError(RECORD_CHANGED_MESSAGE);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ws-section" aria-labelledby="pay-policy-h">
      <h2 id="pay-policy-h">Payments at the counter</h2>
      <p>{words(base)}</p>
      {canEdit ? (
        <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
          <fieldset className="ws-frozen" disabled={busy}>
            <label className="ws-check">
              <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Allow part payments of bills
            </label>
          </fieldset>
          {on !== base && <p className="ws-muted">After saving: {words(on)}</p>}
          {notice && <Alert tone="ok">{notice}</Alert>}
          {error && <Alert tone="warn">{error}</Alert>}
          <Button type="submit" busy={busy}>Save payment setting</Button>
        </form>
      ) : <p className="ws-muted">Only an owner can change this.</p>}
    </section>
  );
}
