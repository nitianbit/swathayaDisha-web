import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Building2, CalendarCheck, CalendarClock, ClipboardList, FlaskConical, History, MapPin, Receipt, Stethoscope, Users, Wallet, CalendarPlus } from 'lucide-react';
import {
  GSTIN_PATTERN, INVOICE_PREFIX_PATTERN, OBJECT_ID_PATTERN, PAN_PATTERN, PARTNER_KIND_LABEL, partnerAdminApi, TAX_REGIME_LABEL,
  VERIFICATION_LABEL, type Partner, type PartnerUpdate, type TaxRegime,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { changedFields, isRecordChanged, RECORD_CHANGED_MESSAGE, staleMessage, useDraft } from '../../draft.ts';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/admin/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { useSession } from '../../session.tsx';
import { NoSuchPartner } from '../partner/scope.tsx';
import { PartnerStateActions } from './PartnerStateActions.tsx';
import { stateTone } from './PartnersScreen.tsx';

const REGIMES: TaxRegime[] = ['unregistered', 'regular', 'composition'];

/** Admin: one partner account: its details, verification, tax settings and its workspace (as owner). */
export function PartnerScreen() {
  const { partnerId = '' } = useParams();
  if (!OBJECT_ID_PATTERN.test(partnerId)) return <NoSuchPartner />;
  // One subtree per partner: a half-typed tax form never follows the admin to another partner.
  return <PartnerDetail key={partnerId} partnerId={partnerId} />;
}

function PartnerDetail({ partnerId }: { partnerId: string }) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['admin-partners', 'one', partnerId], queryFn: () => partnerAdminApi(api).get(partnerId) });
  const p = q.data;
  const root = `/admin/partners/${partnerId}`;
  return (
    <>
      <Link className="ws-back" to="/admin/partners"><ArrowLeft size={16} aria-hidden="true" /> {t('common.backToPartners')}</Link>
      <PageHeading title={p?.name ?? t('partner.title')}>{p ? kindLine(p) : null}</PageHeading>
      {p?.kind === 'lab' && <div><Link to={`${root}/referral-cuts`}>{t('partner.referralCuts')}</Link></div>}
      {q.isPending ? <Loading label={t('partner.loading')} />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="state-h">
              <h2 id="state-h">{t('common.status')}</h2>
              <dl className="ws-dl">
                <dt>{t('common.verification')}</dt><dd><Badge tone={stateTone(p!.verification?.state)}>{VERIFICATION_LABEL[p!.verification?.state] ?? p!.verification?.state}</Badge></dd>
                {p!.verification?.verifiedAt && <><dt>{t('common.verified')}</dt><dd>{formatDateTime(p!.verification.verifiedAt)}</dd></>}
                <dt>{t('common.active')}</dt><dd>{p!.isActive ? t('partner.yes') : t('partner.no')}</dd>
                <dt>{t('partner.owners')}</dt><dd>{p!.activeOwnerCount}</dd>
                <dt>{t('partners.contact')}</dt><dd>{p!.contact?.phone}{p!.contact?.email ? ` · ${p!.contact.email}` : ''}</dd>
                <dt>{t('partner.legalName')}</dt><dd>{p!.legalName || '—'}</dd>
                <dt>{t('common.added')}</dt><dd>{formatDateTime(p!.createdAt)}</dd>
              </dl>
              <PartnerStateActions partner={p!} />
            </section>
            <section className="ws-section" aria-labelledby="manage-h">
              <h2 id="manage-h">{t('partner.manage.title')}</h2>
              <p className="ws-muted">{t('partner.manage.intro', { name: p!.name })}</p>
              <ul className="home-links">
                <li><Link className="home-link" to={`${root}/profile`}><Building2 size={22} aria-hidden="true" /><span>{t('partner.manage.profile')}</span></Link></li>
                <li><Link className="home-link" to={`${root}/staff`}><Users size={22} aria-hidden="true" /><span>{t('partner.manage.staff')}</span></Link></li>
                <li><Link className="home-link" to={`${root}/branches`}><MapPin size={22} aria-hidden="true" /><span>{t('partner.manage.branches')}</span></Link></li>
                <li><Link className="home-link" to={`${root}/audit`}><History size={22} aria-hidden="true" /><span>{t('partner.manage.audit')}</span></Link></li>
                <li><Link className="home-link" to={`${root}/catalogue`}><ClipboardList size={22} aria-hidden="true" /><span>{p!.kind === 'clinic' ? t('partner.manage.clinicCatalogue') : t('partner.manage.labCatalogue')}</span></Link></li>
                <li><Link className="home-link" to={`${root}/invoices`}><Receipt size={22} aria-hidden="true" /><span>{t('partner.manage.bills')}</span></Link></li>
                {p!.kind === 'lab' && <li><Link className="home-link" to={`${root}/lab-bookings`}><FlaskConical size={22} aria-hidden="true" /><span>{t('partner.manage.labBookings')}</span></Link></li>}
                {p!.kind === 'lab' && <li><Link className="home-link" to={`${root}/slots`}><CalendarClock size={22} aria-hidden="true" /><span>{t('partner.manage.slots')}</span></Link></li>}
                {p!.kind === 'lab' && <li><Link className="home-link" to={`${root}/lab-desk`}><CalendarPlus size={22} aria-hidden="true" /><span>{t('partner.manage.frontDesk')}</span></Link></li>}
                {p!.kind === 'lab' && <li><Link className="home-link" to={`${root}/wallet`}><Wallet size={22} aria-hidden="true" /><span>{t('partner.manage.wallet')}</span></Link></li>}
                <li><Link className="home-link" to={`${root}/finance`}><Wallet size={22} aria-hidden="true" /><span>{t('partner.manage.finance')}</span></Link></li>
                {p!.kind === 'clinic' && <li><Link className="home-link" to={`${root}/desk`}><CalendarCheck size={22} aria-hidden="true" /><span>{t('partner.manage.frontDesk')}</span></Link></li>}
                {p!.kind === 'clinic' && <li><Link className="home-link" to={`${root}/clinic-doctors`}><Stethoscope size={22} aria-hidden="true" /><span>{t('partner.manage.doctors')}</span></Link></li>}
              </ul>
            </section>
            <TaxForm partner={p!} />
          </>
        )}
    </>
  );
}

/** Under the title: the kind ("Lab", "Clinic"), and a clinic run by one doctor says so. */
function kindLine(p: Partner): string {
  const kind = PARTNER_KIND_LABEL[p.kind] ?? p.kind;
  return p.solo ? t('partner.kindSolo', { kind }) : kind;
}

type Tax = { gstin: string; pan: string; taxRegime: TaxRegime; prefix: string };
const taxOf = (p: Partner): Tax => ({ gstin: p.gstin ?? '', pan: p.pan ?? '', taxRegime: p.taxRegime ?? 'unregistered', prefix: p.invoiceSeries?.prefix ?? '' });
/** Each field's name in "Someone else changed the …" (keys; worded when shown). */
const TAX_LABEL = { gstin: 'partners.gstin', pan: 'partners.pan', taxRegime: 'partner.tax.fieldRegime', prefix: 'partner.tax.fieldPrefix' } as const satisfies Record<keyof Tax, string>;
const taxStale = (fields: readonly (keyof Tax)[]) => staleMessage(fields.map((k) => t(TAX_LABEL[k])));

/** The changed tax fields, checked against `updatePartnerSchema` (a set GSTIN or PAN cannot be cleared). */
function taxChanges(changed: Partial<Tax>): { body: PartnerUpdate; errors: Partial<Record<keyof Tax, string>> } {
  const errors: Partial<Record<keyof Tax, string>> = {};
  const body: PartnerUpdate = {};
  if (changed.gstin !== undefined) {
    const v = changed.gstin.trim().toUpperCase();
    if (!v) errors.gstin = t('partner.tax.gstinRemove');
    else if (!GSTIN_PATTERN.test(v)) errors.gstin = t('partners.gstinInvalid');
    else body.gstin = v;
  }
  if (changed.pan !== undefined) {
    const v = changed.pan.trim().toUpperCase();
    if (!v) errors.pan = t('partner.tax.panRemove');
    else if (!PAN_PATTERN.test(v)) errors.pan = t('partners.panInvalid');
    else body.pan = v;
  }
  if (changed.prefix !== undefined) {
    const v = changed.prefix.trim().toUpperCase();
    if (!INVOICE_PREFIX_PATTERN.test(v)) errors.prefix = t('partners.prefixInvalid');
    else body.invoiceSeriesPrefix = v;
  }
  if (changed.taxRegime !== undefined) body.taxRegime = changed.taxRegime;
  return { body, errors };
}

/**
 * Registration and invoicing details only Jansetu changes (`updatePartnerSchema`). Only fields changed from the
 * baseline are sent, after re-reading the partner: a field someone else changed meanwhile is shown for review.
 */
function TaxForm({ partner }: { partner: Partner }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const d = useDraft(() => taxOf(partner));
  const { rebaseTo } = d;
  const [errors, setErrors] = useState<Partial<Record<keyof Tax, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const serverValue = JSON.stringify(taxOf(partner));
  useEffect(() => {
    const c = rebaseTo(JSON.parse(serverValue) as Tax);
    if (c.length) setStale(taxStale(c));
  }, [serverValue, rebaseTo]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null); setStale(null);
    const first = taxChanges(changedFields(d.current()));
    setErrors(first.errors);
    if (Object.keys(first.errors).length) return;
    if (Object.keys(first.body).length === 0) { setNotice(t('partner.tax.unchanged')); return; }
    setBusy(true);
    try {
      const admin = partnerAdminApi(api);
      const fresh = await admin.get(partner._id);
      const conflicts = rebaseTo(taxOf(fresh));
      if (conflicts.length) { setStale(taxStale(conflicts)); return; }
      const { body } = taxChanges(changedFields(d.current()));
      if (Object.keys(body).length === 0) { setNotice(t('partner.tax.unchanged')); return; }
      try {
        // Q10: refused (409 RECORD_CHANGED) if the partner moved after the read above.
        await admin.update(partner._id, body, fresh.updatedAt);
        setNotice(t('partner.tax.saved'));
      } catch (err) {
        if (!isRecordChanged(err)) throw err;
        const c = rebaseTo(taxOf(await admin.get(partner._id)));
        setStale(c.length ? taxStale(c) : RECORD_CHANGED_MESSAGE);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['admin-partners'] });
      await queryClient.invalidateQueries({ queryKey: ['partner-ws', partner._id] });
    }
  }

  const draft = d.draft;
  const text = (k: Exclude<keyof Tax, 'taxRegime'>) => ({ value: draft[k], error: errors[k], onChange: (e: { target: { value: string } }) => d.set(k, e.target.value) });
  return (
    <section className="ws-section" aria-labelledby="tax-h">
      <h2 id="tax-h">{t('partner.tax.title')}</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <fieldset className="ws-frozen" disabled={busy}>
        <div className="rx-form-row">
          <TextField label={t('partners.gstin')} maxLength={15} {...text('gstin')} />
          <TextField label={t('partners.pan')} maxLength={10} {...text('pan')} />
          <div className="j-field">
            <label htmlFor="tax-regime">{t('partners.taxLabel')}</label>
            <select id="tax-regime" value={draft.taxRegime} onChange={(e) => d.set('taxRegime', e.target.value as TaxRegime)}>
              {REGIMES.map((r) => <option key={r} value={r}>{TAX_REGIME_LABEL[r]}</option>)}
            </select>
          </div>
          <TextField label={t('partners.invoicePrefix')} maxLength={6} {...text('prefix')} />
        </div>
        </fieldset>
        {stale && <Alert tone="warn">{stale}</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div><Button type="submit" busy={busy}>{t('partner.tax.save')}</Button></div>
      </form>
    </section>
  );
}
