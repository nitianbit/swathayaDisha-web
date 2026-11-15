import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  EMAIL_PATTERN, MAX_NAME, PARTNER_KIND_LABEL, PARTNER_PHONE_PATTERN, TAX_REGIME_LABEL, VERIFICATION_LABEL,
  type MyPartnerUpdate, type Partner,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
import { NoSuchPartner, PartnerPageHeading, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

type Fields = { name: string; legalName: string; contactPhone: string; contactEmail: string };
const fieldsOf = (p: Partner): Fields => ({
  name: p.name ?? '', legalName: p.legalName ?? '', contactPhone: p.contact?.phone ?? '', contactEmail: p.contact?.email ?? '',
});

/** Checks against `updateMyPartnerSchema`; only changed fields are sent (the backend cannot clear a field). */
export function profileChanges(before: Fields, now: Fields): { changes: MyPartnerUpdate; errors: Partial<Record<keyof Fields, string>> } {
  const errors: Partial<Record<keyof Fields, string>> = {};
  const changes: MyPartnerUpdate = {};
  for (const key of Object.keys(now) as (keyof Fields)[]) {
    const value = now[key].trim();
    if (value === before[key].trim()) continue;
    if (!value) { errors[key] = before[key] ? 'This cannot be removed here. Enter a new value.' : 'Enter a value.'; continue; }
    if ((key === 'name' || key === 'legalName') && value.length > MAX_NAME) { errors[key] = `Use at most ${MAX_NAME} characters.`; continue; }
    if (key === 'contactPhone' && !PARTNER_PHONE_PATTERN.test(value)) { errors[key] = 'Enter the 10-digit mobile number.'; continue; }
    if (key === 'contactEmail' && !EMAIL_PATTERN.test(value)) { errors[key] = 'Enter a valid email address.'; continue; }
    changes[key] = value;
  }
  return { changes, errors };
}

/** Partner profile: the details its members may change (`PUT /me`), and the ones only Jansetu changes. */
export function ProfileScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  return <Profile ctx={ctx} />;
}

function Profile({ ctx }: { ctx: ScopeContext }) {
  const queryClient = useQueryClient();
  const me = useWorkspacePartner(ctx);
  const [form, setForm] = useState<Fields>({ name: '', legalName: '', contactPhone: '', contactEmail: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof Fields, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (me.data) setForm(fieldsOf(me.data)); }, [me.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!me.data) return;
    const { changes, errors: errs } = profileChanges(fieldsOf(me.data), form);
    setErrors(errs); setError(null); setNotice(null);
    if (Object.keys(errs).length) return;
    if (Object.keys(changes).length === 0) { setNotice('Nothing has changed.'); return; }
    setBusy(true);
    try {
      const updated = await ctx.api.updateMe(changes);
      queryClient.setQueryData([...ctx.key, 'me'], updated);
      setNotice('Saved.');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof Fields) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
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
              </dl>
              <p className="ws-muted">Registration and tax details are changed by Jansetu.</p>
            </section>
            <section className="ws-section" aria-labelledby="edit-h">
              <h2 id="edit-h">Contact details</h2>
              <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
                <div className="rx-form-row">
                  <TextField label="Display name" value={form.name} onChange={set('name')} error={errors.name} maxLength={MAX_NAME} autoComplete="organization" />
                  <TextField label="Legal name" value={form.legalName} onChange={set('legalName')} error={errors.legalName} maxLength={MAX_NAME} />
                </div>
                <div className="rx-form-row">
                  <TextField label="Contact phone" inputMode="numeric" maxLength={10} value={form.contactPhone}
                    onChange={(e) => setForm((f) => ({ ...f, contactPhone: e.target.value.replace(/\D/g, '') }))} error={errors.contactPhone} />
                  <TextField label="Contact email" type="email" value={form.contactEmail} onChange={set('contactEmail')} error={errors.contactEmail} autoComplete="email" />
                </div>
                {notice && <Alert tone="ok">{notice}</Alert>}
                {error && <Alert>{error}</Alert>}
                <Button type="submit" busy={busy}>Save</Button>
              </form>
            </section>
          </>
        )}
    </>
  );
}
