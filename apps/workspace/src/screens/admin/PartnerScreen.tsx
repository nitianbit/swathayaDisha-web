import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Building2, History, MapPin, Users } from 'lucide-react';
import {
  GSTIN_PATTERN, INVOICE_PREFIX_PATTERN, OBJECT_ID_PATTERN, PAN_PATTERN, PARTNER_KIND_LABEL, partnerAdminApi, TAX_REGIME_LABEL,
  VERIFICATION_LABEL, type Partner, type PartnerUpdate, type TaxRegime,
} from '@jansetu/api';
import { Alert, Badge, Button, ErrorState, formatDateTime, Loading, TextField } from '@jansetu/ui';
import { messageOf } from '../../errors.ts';
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
  return <PartnerDetail partnerId={partnerId} />;
}

function PartnerDetail({ partnerId }: { partnerId: string }) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['admin-partners', 'one', partnerId], queryFn: () => partnerAdminApi(api).get(partnerId) });
  const p = q.data;
  const root = `/admin/partners/${partnerId}`;
  return (
    <>
      <Link className="ws-back" to="/admin/partners"><ArrowLeft size={16} aria-hidden="true" /> Back to labs and clinics</Link>
      <PageHeading title={p?.name ?? 'Lab or clinic'}>{p ? `${PARTNER_KIND_LABEL[p.kind] ?? p.kind}${p.solo ? ' · single-doctor practice' : ''}` : null}</PageHeading>
      {q.isPending ? <Loading label="Loading partner…" />
        : q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} />
        : (
          <>
            <section className="ws-section" aria-labelledby="state-h">
              <h2 id="state-h">Status</h2>
              <dl className="ws-dl">
                <dt>Verification</dt><dd><Badge tone={stateTone(p!.verification?.state)}>{VERIFICATION_LABEL[p!.verification?.state] ?? p!.verification?.state}</Badge></dd>
                {p!.verification?.verifiedAt && <><dt>Verified</dt><dd>{formatDateTime(p!.verification.verifiedAt)}</dd></>}
                <dt>Active</dt><dd>{p!.isActive ? 'Yes' : 'No'}</dd>
                <dt>Owners</dt><dd>{p!.activeOwnerCount}</dd>
                <dt>Contact</dt><dd>{p!.contact?.phone}{p!.contact?.email ? ` · ${p!.contact.email}` : ''}</dd>
                <dt>Legal name</dt><dd>{p!.legalName || '—'}</dd>
                <dt>Added</dt><dd>{formatDateTime(p!.createdAt)}</dd>
              </dl>
              <PartnerStateActions partner={p!} />
            </section>
            <section className="ws-section" aria-labelledby="manage-h">
              <h2 id="manage-h">Manage as owner</h2>
              <p className="ws-muted">Everything an owner of {p!.name} can do. Your changes are recorded as a Jansetu admin in its activity log.</p>
              <ul className="home-links">
                <li><Link className="home-link" to={`${root}/profile`}><Building2 size={22} aria-hidden="true" /><span>Profile</span></Link></li>
                <li><Link className="home-link" to={`${root}/staff`}><Users size={22} aria-hidden="true" /><span>Staff</span></Link></li>
                <li><Link className="home-link" to={`${root}/branches`}><MapPin size={22} aria-hidden="true" /><span>Branches</span></Link></li>
                <li><Link className="home-link" to={`${root}/audit`}><History size={22} aria-hidden="true" /><span>Activity log</span></Link></li>
              </ul>
            </section>
            <TaxForm partner={p!} />
          </>
        )}
    </>
  );
}

type Tax = { gstin: string; pan: string; taxRegime: TaxRegime; prefix: string };
const taxOf = (p: Partner): Tax => ({ gstin: p.gstin ?? '', pan: p.pan ?? '', taxRegime: p.taxRegime ?? 'unregistered', prefix: p.invoiceSeries?.prefix ?? '' });

/** Registration and invoicing details only Jansetu changes (`updatePartnerSchema`); only changed fields are sent. */
function TaxForm({ partner }: { partner: Partner }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [t, setT] = useState<Tax>(() => taxOf(partner));
  const [errors, setErrors] = useState<Partial<Record<keyof Tax, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setT(taxOf(partner)); }, [partner]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const before = taxOf(partner);
    const errs: Partial<Record<keyof Tax, string>> = {};
    const body: PartnerUpdate = {};
    const gstin = t.gstin.trim().toUpperCase();
    const pan = t.pan.trim().toUpperCase();
    const prefix = t.prefix.trim().toUpperCase();
    if (gstin !== before.gstin) {
      if (!gstin) errs.gstin = 'A GSTIN cannot be removed here. Enter a new one.';
      else if (!GSTIN_PATTERN.test(gstin)) errs.gstin = 'Enter a valid 15-character GSTIN.';
      else body.gstin = gstin;
    }
    if (pan !== before.pan) {
      if (!pan) errs.pan = 'A PAN cannot be removed here. Enter a new one.';
      else if (!PAN_PATTERN.test(pan)) errs.pan = 'Enter a valid 10-character PAN.';
      else body.pan = pan;
    }
    if (prefix !== before.prefix) {
      if (!INVOICE_PREFIX_PATTERN.test(prefix)) errs.prefix = 'Use 1 to 6 letters or digits.';
      else body.invoiceSeriesPrefix = prefix;
    }
    if (t.taxRegime !== before.taxRegime) body.taxRegime = t.taxRegime;
    setErrors(errs); setError(null); setNotice(null);
    if (Object.keys(errs).length) return;
    if (Object.keys(body).length === 0) { setNotice('Nothing has changed.'); return; }
    setBusy(true);
    try {
      await partnerAdminApi(api).update(partner._id, body);
      await queryClient.invalidateQueries({ queryKey: ['admin-partners'] });
      await queryClient.invalidateQueries({ queryKey: ['partner-ws', partner._id] });
      setNotice('Saved.');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const text = (k: Exclude<keyof Tax, 'taxRegime'>) => ({ value: t[k], error: errors[k], onChange: (e: { target: { value: string } }) => setT((x) => ({ ...x, [k]: e.target.value })) });
  return (
    <section className="ws-section" aria-labelledby="tax-h">
      <h2 id="tax-h">Tax and invoicing</h2>
      <form className="rx-form" noValidate onSubmit={(e) => void save(e)}>
        <div className="rx-form-row">
          <TextField label="GSTIN" maxLength={15} {...text('gstin')} />
          <TextField label="PAN" maxLength={10} {...text('pan')} />
          <div className="j-field">
            <label htmlFor="tax-regime">Tax</label>
            <select id="tax-regime" value={t.taxRegime} onChange={(e) => setT((x) => ({ ...x, taxRegime: e.target.value as TaxRegime }))}>
              {REGIMES.map((r) => <option key={r} value={r}>{TAX_REGIME_LABEL[r]}</option>)}
            </select>
          </div>
          <TextField label="Invoice prefix" maxLength={6} {...text('prefix')} />
        </div>
        {notice && <Alert tone="ok">{notice}</Alert>}
        {error && <Alert>{error}</Alert>}
        <div><Button type="submit" busy={busy}>Save tax details</Button></div>
      </form>
    </section>
  );
}
