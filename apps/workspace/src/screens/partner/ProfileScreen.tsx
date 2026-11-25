import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  canEditProfile, EMAIL_PATTERN, MAX_NAME, PARTNER_KIND_LABEL, PARTNER_PHONE_PATTERN, TAX_REGIME_LABEL, tooLongWords, VERIFICATION_LABEL,
  type MyPartnerUpdate, type Partner,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, shared, TextField } from '@jansetu/ui';
import { dirtyKeys, isRecordChanged, RECORD_CHANGED_MESSAGE, staleMessage, useDraft, type DraftState } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { NoSuchPartner, PartnerPageHeading, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t, type PartnerKey } from '../../i18n/partner/index.ts';

type Fields = { name: string; legalName: string; contactPhone: string; contactEmail: string };
const fieldsOf = (p: Partner): Fields => ({
  name: p.name ?? '', legalName: p.legalName ?? '', contactPhone: p.contact?.phone ?? '', contactEmail: p.contact?.email ?? '',
});
const FIELD_KEY = {
  name: 'profile.field.name', legalName: 'profile.field.legalName', contactPhone: 'profile.field.contactPhone', contactEmail: 'profile.field.contactEmail',
} as const satisfies Record<keyof Fields, PartnerKey>;
const fieldLabel = (k: keyof Fields) => t(FIELD_KEY[k]);

/** Checks the changed fields against `updateMyPartnerSchema` (the backend cannot clear a field). */
export function profileChanges(s: DraftState<Fields>): { changes: MyPartnerUpdate; errors: Partial<Record<keyof Fields, string>> } {
  const errors: Partial<Record<keyof Fields, string>> = {};
  const changes: MyPartnerUpdate = {};
  for (const key of dirtyKeys(s)) {
    const value = s.draft[key].trim();
    if (value === s.base[key].trim()) continue;
    if (!value) { errors[key] = s.base[key] ? t('common.cannotRemove') : t('profile.enterValue'); continue; }
    if ((key === 'name' || key === 'legalName') && value.length > MAX_NAME) { errors[key] = tooLongWords(MAX_NAME); continue; }
    if (key === 'contactPhone' && !PARTNER_PHONE_PATTERN.test(value)) { errors[key] = t('profile.enterMobile'); continue; }
    if (key === 'contactEmail' && !EMAIL_PATTERN.test(value)) { errors[key] = t('profile.enterEmail'); continue; }
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
  const [policyMessage, setPolicyMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const p = me.data;
  return (
    <>
      <PartnerPageHeading ctx={ctx} title={t('profile.title')} partnerName={p?.name}>{t('profile.intro')}</PartnerPageHeading>
      {me.isPending ? <Loading label={t('profile.loading')} />
        : me.isError ? <ErrorState message={messageOf(me.error)} onRetry={() => void me.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="org-h">
              <h2 id="org-h">{p!.name}</h2>
              <dl className="ws-dl">
                <dt>{t('profile.type')}</dt><dd>{p!.solo ? t('profile.kindSolo', { kind: PARTNER_KIND_LABEL[p!.kind] ?? p!.kind }) : PARTNER_KIND_LABEL[p!.kind] ?? p!.kind}</dd>
                <dt>{t('profile.status')}</dt>
                <dd>
                  <Badge tone={p!.verification?.state === 'verified' ? 'ok' : p!.verification?.state === 'suspended' ? 'danger' : 'warn'}>
                    {VERIFICATION_LABEL[p!.verification?.state] ?? p!.verification?.state ?? '—'}
                  </Badge>
                </dd>
                {p!.verification?.verifiedAt && <><dt>{t('profile.verified')}</dt><dd>{formatDateTime(p!.verification.verifiedAt)}</dd></>}
                <dt>{t('profile.gstin')}</dt><dd>{p!.gstin || '—'}</dd>
                <dt>{t('profile.pan')}</dt><dd>{p!.pan || '—'}</dd>
                <dt>{t('profile.tax')}</dt><dd>{TAX_REGIME_LABEL[p!.taxRegime] ?? p!.taxRegime ?? '—'}</dd>
                <dt>{t('profile.invoicePrefix')}</dt><dd>{p!.invoiceSeries?.prefix || '—'}</dd>
                <dt>{t('profile.owners')}</dt><dd>{p!.activeOwnerCount}</dd>
                {!canEditProfile(ctx.actor) && <>
                  <dt>{t('profile.legalName')}</dt><dd>{p!.legalName || '—'}</dd>
                  <dt>{t('profile.contact')}</dt><dd>{p!.contact?.phone}{p!.contact?.email ? ` · ${p!.contact.email}` : ''}</dd>
                </>}
              </dl>
              <p className="ws-muted">
                {canEditProfile(ctx.actor) ? t('profile.changedByJansetu') : t('profile.ownerOnlyDetails')}
              </p>
            </section>
            {canEditProfile(ctx.actor) && <ContactForm ctx={ctx} partner={p!} />}
            <section className="ws-section" aria-labelledby="pay-policy-h">
              <h2 id="pay-policy-h">{t('profile.counterPayments')}</h2>
              {/* The message outlives the form, which starts again from every newer version of the partner. */}
              {policyMessage && <Alert tone={policyMessage.tone}>{policyMessage.text}</Alert>}
              <CounterPayments key={p!.updatedAt ?? ''} ctx={ctx} partner={p!} onMessage={setPolicyMessage} />
            </section>
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
    if (c.length) setStale(staleMessage(c.map(fieldLabel)));
  }, [partner, rebaseTo]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setStale(null);
    const first = profileChanges(d.current());
    setErrors(first.errors);
    if (Object.keys(first.errors).length) return;
    if (Object.keys(first.changes).length === 0) { setNotice(t('common.nothingChanged')); return; }
    setBusy(true);
    try {
      // The edit is checked against what is saved now, not only against the page's last read.
      const fresh = await ctx.api.me();
      queryClient.setQueryData([...ctx.key, 'me'], fresh);
      const conflicts = rebaseTo(fieldsOf(fresh));
      if (conflicts.length) { setStale(staleMessage(conflicts.map(fieldLabel))); return; }
      const { changes } = profileChanges(d.current());
      if (Object.keys(changes).length === 0) { setNotice(t('common.nothingChanged')); return; }
      try {
        // Q10: refused (409 RECORD_CHANGED) if the profile moved after the read above.
        const updated = await ctx.api.updateMe(changes, fresh.updatedAt);
        queryClient.setQueryData([...ctx.key, 'me'], updated);
        setNotice(t('profile.saved'));
      } catch (err) {
        if (!isRecordChanged(err)) throw err;
        const latest = await ctx.api.me();
        queryClient.setQueryData([...ctx.key, 'me'], latest);
        const c = rebaseTo(fieldsOf(latest));
        setStale(c.length ? staleMessage(c.map(fieldLabel)) : RECORD_CHANGED_MESSAGE);
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
      <h2 id="edit-h">{t('profile.contactDetails')}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <fieldset className="ws-frozen" disabled={busy}>
        <div className="rx-form-row">
          <TextField label={t('profile.displayName')} value={f.name} onChange={set('name')} error={errors.name} maxLength={MAX_NAME} autoComplete="organization" />
          <TextField label={t('profile.legalName')} value={f.legalName} onChange={set('legalName')} error={errors.legalName} maxLength={MAX_NAME} />
        </div>
        <div className="rx-form-row">
          <TextField label={t('profile.contactPhone')} inputMode="numeric" maxLength={10} value={f.contactPhone}
            onChange={(e) => d.set('contactPhone', e.target.value.replace(/\D/g, ''))} error={errors.contactPhone} />
          <TextField label={t('profile.contactEmail')} type="email" value={f.contactEmail} onChange={set('contactEmail')} error={errors.contactEmail} autoComplete="email" />
        </div>
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <Button type="submit" busy={busy}>{shared('action.save')}</Button>
      </form>
    </section>
  );
}

/**
 * Q14 `allowPartPayments` (default off): whether an in-house bill may be paid in several payments. Owners (and admins as
 * owner) change it; the choice is checked against what is saved right before sending (another change meanwhile resets it
 * for review) and the write names that version (`expectedUpdatedAt`, 409 RECORD_CHANGED).
 */
function CounterPayments({ ctx, partner, onMessage }: {
  ctx: ScopeContext; partner: Partner; onMessage: (m: { tone: 'ok' | 'warn'; text: string } | null) => void;
}) {
  const queryClient = useQueryClient();
  const base = partner.allowPartPayments === true;
  const [on, setOn] = useState(base);
  const [busy, setBusy] = useState(false);
  const setNotice = (text: string) => onMessage({ tone: 'ok', text });
  const setError = (text: string) => onMessage({ tone: 'warn', text });
  const canEdit = canEditProfile(ctx.actor);
  const words = (v: boolean) => (v
    ? t('profile.partPayments.on')
    : t('profile.partPayments.off'));

  async function save(e: FormEvent) {
    e.preventDefault();
    onMessage(null);
    if (on === base) { setNotice(t('common.nothingChanged')); return; }
    setBusy(true);
    try {
      const fresh = await ctx.api.me();
      if ((fresh.allowPartPayments === true) !== base) {
        queryClient.setQueryData([...ctx.key, 'me'], fresh);
        setError(t('profile.partPayments.changedMeanwhile'));
        return;
      }
      try {
        const updated = await ctx.api.updateMe({ allowPartPayments: on }, fresh.updatedAt);
        setNotice(t('profile.saved'));
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
    <>
      <p>{words(base)}</p>
      {canEdit ? (
        <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
          <fieldset className="ws-frozen" disabled={busy}>
            <label className="ws-check">
              <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> {t('profile.partPayments.allow')}
            </label>
          </fieldset>
          {on !== base && <p className="ws-muted">{t('profile.partPayments.afterSaving', { setting: words(on) })}</p>}
          <Button type="submit" busy={busy}>{t('profile.partPayments.save')}</Button>
        </form>
      ) : <p className="ws-muted">{t('profile.ownerOnly')}</p>}
    </>
  );
}
