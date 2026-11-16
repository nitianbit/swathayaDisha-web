import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  allowedGstRates, ApiError, chargesGst, customerGstinProblem, INVOICE_PHONE_PATTERN, MAX_LINE_DESCRIPTION,
  MAX_LINES, MAX_NAME, MAX_PRICE_MINOR, MAX_QTY, MAX_SAC, paiseToInput, previewInvoice, rupeesToPaise, STATE_CODE_PATTERN,
  type Branch, type CatalogueItem, type ClinicDoctor, type GstRate, type Invoice, type InvoiceGender, type InvoicePreview,
  type NewInvoice, type NewInvoiceLine, type Page, type Partner,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading, TextField } from '@jansetu/ui';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { afterFailure, beginAttempt, newRequestKey, resolveStored, startOp, stillCurrent, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { money, useCatalogue, useClinicDoctors } from './billing.tsx';
import { Totals } from './InvoiceScreen.tsx';
import { NoSuchPartner, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';

type Pending = PendingOp<NewInvoice>;

interface LineDraft {
  key: string;
  /** Lines from the catalogue keep its name, price and GST rate; only quantity and discount change. */
  item?: Pick<CatalogueItem, '_id' | 'name' | 'priceMinor' | 'gstRate' | 'sac'>;
  description: string; sac: string; qty: string; price: string; discount: string; gstRate: string;
}
export interface InvoiceDraft {
  branchId: string; name: string; phone: string; age: string; gender: '' | InvoiceGender; gstin: string; placeOfSupply: string;
  doctorId: string; lines: LineDraft[];
}

/** The bill type in a sentence. */
const KIND_TEXT = { tax_invoice: 'a tax invoice', bill_of_supply: 'a bill of supply', commercial_invoice: 'an invoice without GST' } as const;

const EMPTY: InvoiceDraft = { branchId: '', name: '', phone: '', age: '', gender: '', gstin: '', placeOfSupply: '', doctorId: '', lines: [] };
let lineSeq = 0;
const lineKey = () => `l${++lineSeq}`;

/**
 * Validates a draft against `createInvoiceSchema` and builds the request (without its key) and the preview of what the
 * server will compute. Amounts typed in rupees go out as integer paise.
 */
export function buildInvoice(d: InvoiceDraft, partner: Pick<Partner, 'taxRegime' | 'gstin'>, branch: Pick<Branch, 'address'> | undefined,
  offeredIds?: ReadonlySet<string>):
  { body: Omit<NewInvoice, 'idempotencyKey'>; errors: Record<string, string>; preview: InvoicePreview } {
  const errors: Record<string, string> = {};
  const rates = allowedGstRates(partner);
  if (!d.branchId || !branch) errors.branchId = 'Choose the branch issuing the bill.';
  const name = d.name.trim();
  if (!name) errors.name = 'Enter the customer’s name.';
  else if (name.length > MAX_NAME) errors.name = `Use at most ${MAX_NAME} characters.`;
  const phone = d.phone.replace(/[\s-]/g, '');
  if (phone && !INVOICE_PHONE_PATTERN.test(phone)) errors.phone = 'Enter a 10-digit mobile number.';
  const age = d.age.trim();
  if (age && (!/^\d{1,3}$/.test(age) || Number(age) > 150)) errors.age = 'Enter the age in whole years (0 to 150).';
  const gstin = d.gstin.trim().toUpperCase();
  const gstinProblem = customerGstinProblem(gstin);
  if (gstinProblem) errors.gstin = gstinProblem;
  const pos = d.placeOfSupply.trim();
  if (pos && !STATE_CODE_PATTERN.test(pos)) errors.placeOfSupply = 'Enter the two-digit GST state code, like 29.';

  if (d.lines.length === 0) errors.lines = 'Add at least one item.';
  else if (d.lines.length > MAX_LINES) errors.lines = `A bill can have at most ${MAX_LINES} items.`;
  const items: NewInvoiceLine[] = d.lines.map((l) => {
    const e = (field: string, text: string) => { errors[`${l.key}.${field}`] = text; };
    const description = (l.item?.name ?? l.description).trim();
    if (!description) e('description', 'Describe the item.');
    else if (description.length > MAX_LINE_DESCRIPTION) e('description', `Use at most ${MAX_LINE_DESCRIPTION} characters.`);
    const sac = (l.item ? l.item.sac ?? '' : l.sac).trim();
    if (sac.length > MAX_SAC) e('sac', `Use at most ${MAX_SAC} characters.`);
    const qty = /^\d{1,5}$/.test(l.qty.trim()) ? Number(l.qty.trim()) : NaN;
    if (!(qty >= 1 && qty <= MAX_QTY)) e('qty', `Enter a whole number from 1 to ${MAX_QTY}.`);
    const price = l.item ? l.item.priceMinor : rupeesToPaise(l.price);
    if (price === null) e('price', l.price.trim() ? 'Enter rupees, like 450 or 450.50.' : 'Enter the price.');
    else if (price > MAX_PRICE_MINOR) e('price', 'This price is above the largest the server accepts.');
    const discount = l.discount.trim() ? rupeesToPaise(l.discount) : 0;
    if (discount === null) e('discount', 'Enter rupees, like 50 or 50.50.');
    const gstRate = (l.item ? l.item.gstRate : Number(l.gstRate)) as GstRate;
    if (!l.item && !rates.includes(gstRate)) e('gstRate', 'Choose one of the GST rates offered.');
    return {
      ...(l.item ? { catalogItemId: l.item._id } : {}),
      description,
      ...(sac ? { sac } : {}),
      qty: Number.isFinite(qty) ? qty : 0,
      unitPriceMinor: price ?? 0,
      ...(discount ? { discountMinor: discount } : {}),
      gstRate,
    };
  });
  const stateCode = branch?.address?.stateCode ?? '';
  const preview = previewInvoice(partner, stateCode, pos || undefined, items);
  preview.lines.forEach((p, i) => { if (p.problem) errors[`${d.lines[i]!.key}.amount`] = p.problem; });
  // A catalogue line whose item is no longer offered (deactivated or disabled by Jansetu) cannot be billed.
  d.lines.forEach((l) => {
    if (l.item && offeredIds && !offeredIds.has(l.item._id)) errors[`${l.key}.amount`] = `${l.item.name} is no longer offered: remove this line.`;
  });
  if (branch && !stateCode) errors.branchId = 'Set the branch GST state code before billing (Branches).';
  const general = preview.problems.filter((p) => !preview.lines.some((l) => l.problem === p));
  if (general.length) errors.bill = general.join(' ');
  return {
    body: {
      branchId: d.branchId,
      customer: {
        name, ...(phone ? { phone } : {}), ...(gstin ? { gstin } : {}), ...(age ? { age: Number(age) } : {}),
        ...(d.gender ? { gender: d.gender } : {}), ...(pos ? { placeOfSupply: pos } : {}),
      },
      ...(d.doctorId ? { doctorId: d.doctorId } : {}),
      items,
    },
    errors,
    preview,
  };
}

/**
 * Q10 `GET /invoices/by-key/:key` as the "records" a pending bill is looked up in: the bill that key issued, or none
 * (404). Exact, so "not found" means not issued (yet): the server can then abandon the key for good.
 */
function keyLookup(ctx: ScopeContext, key: string) {
  return async (page: number): Promise<Page<Invoice & { requestKey: string; createdAt: string }>> => {
    let items: (Invoice & { requestKey: string; createdAt: string })[] = [];
    try {
      const inv = await ctx.billing.invoiceByKey(key);
      items = [{ ...inv, requestKey: inv.idempotencyKey, createdAt: inv.issuedAt }];
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    return { items, page, limit: 1, total: items.length, totalPages: 1 };
  };
}

/** A new in-house bill (`invoices.create`). */
export function NewInvoiceScreen() {
  const ctx = usePartnerScope();
  if (!ctx) return <NoSuchPartner />;
  // One subtree per partner: a draft, a review step or a running issue never moves to another partner.
  return <NewInvoice key={scopeIdentity(ctx)} ctx={ctx} />;
}

function NewInvoice({ ctx }: { ctx: ScopeContext }) {
  const { memory } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const partner = useWorkspacePartner(ctx);
  const branches = useBranches(ctx);
  const catalogue = useCatalogue(ctx);
  const doctors = useClinicDoctors(ctx, partner.data?.kind);
  // The unconfirmed bill (memory and reload marker) belongs to this partner only.
  const slot = `partner-invoice:new:${scopeIdentity(ctx)}`;
  const [pending, setPendingState] = useState<Pending | undefined>(() => memory.get<Pending>(slot));
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const setPending = (p: Pending | undefined) => {
    if (p) memory.set(slot, p); else memory.delete(slot);
    setPendingState(p);
  };
  const [refused, setRefused] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  /** `requestKey` produced this bill (answer, replay or found in the list): end it, and only it, then open the bill. */
  const issued = (inv: Invoice, requestKey: string, earlier = false) => {
    resolveStored(memory, slot, requestKey);
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'invoices'] });
    if (!mounted.current) return;
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    const linked = inv.customer?.userId ? ' It was added to the customer’s Jansetu account (Bills in their app).' : '';
    navigate(`${ctx.link('invoices')}/${inv._id}`, {
      state: { issued: `${earlier ? `Bill ${inv.serial} had already been issued.` : `Bill ${inv.serial} issued.`}${linked}` },
    });
  };

  /** Sends exactly `p` (same key, same content). Only success, or a definite refusal of its FIRST attempt, ends it. */
  async function send(p: Pending) {
    const attempt = beginAttempt(p);
    setBusy(true);
    setRefused(null);
    setGaveUp(false);
    setPending(attempt);
    try {
      issued(await ctx.billing.createInvoice(attempt.body), attempt.requestKey);
    } catch (err) {
      // Q10: a catalogue line no longer matches the catalogue: read it again so the form shows the change.
      if (err instanceof ApiError && err.code === 'CATALOGUE_PRICE_CHANGED') void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'catalogue'] });
      if (!stillCurrent(memory.get<Pending>(slot), attempt)) return;
      // Customer linking is checked before anything is written; on a first attempt that refusal is definite too.
      const linkingOff = err instanceof ApiError && err.code === 'CUSTOMER_LINKING_UNAVAILABLE' && attempt.attempts === 1 && !attempt.uncertain;
      const next = linkingOff ? null : afterFailure(attempt, err, messageOf(err));
      if (mounted.current) {
        setPending(next ?? undefined);
        if (!next) setRefused(messageOf(err));
      } else if (next) memory.set(slot, next); else memory.delete(slot);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const p = partner.data;
  return (
    <>
      <Link className="ws-back" to={ctx.link('invoices')}><ArrowLeft size={16} aria-hidden="true" /> Back to bills</Link>
      <PageHeading title="New bill">
        {ctx.adminHome ? <>Managing {p?.name ?? 'this partner'} with owner authority. </> : null}
        Issued in {p?.name ?? 'this'}’s own series. The server works out the final amounts.
      </PageHeading>
      {pending && !(busy && pending.attempts === 1 && !pending.uncertain) ? (
        <PendingOpPanel key={pending.attempts} label="Unconfirmed bill" op={pending} busy={busy} onResend={() => void send(pending)}
          fetchPage={keyLookup(ctx, pending.requestKey)}
          onFound={(inv) => issued(inv, pending.requestKey, true)}
          // Q10: giving up is decided by the server: `abandoned` = this bill can never be issued; `used` = here it is.
          abandon={async () => {
            const r = await ctx.billing.abandonInvoiceKey(pending.requestKey);
            return { state: r.state, record: r.invoice ? { ...r.invoice, requestKey: r.invoice.idempotencyKey, createdAt: r.invoice.issuedAt } : undefined };
          }}
          abandonWhenNotFound abandonLabel="Give up this bill"
          onDiscard={() => {
            const k = pending.requestKey;
            resolveStored(memory, slot, k);
            setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
            setGaveUp(true);
          }}
          summary={pending.restored ? null : <PendingSummary body={pending.body} />} />
      ) : partner.isPending || branches.isPending || catalogue.isPending ? <Loading label="Loading…" />
        : partner.isError ? <ErrorState message={messageOf(partner.error)} onRetry={() => void partner.refetch()} />
        : branches.isError ? <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />
        : catalogue.isError ? <ErrorState message={messageOf(catalogue.error)} onRetry={() => void catalogue.refetch()} />
        : branches.data.length === 0 ? <Empty title="No branch to bill from">A bill is issued by a branch. {ctx.actor.role === 'owner' ? 'Add one under Branches first.' : 'Ask an owner for access to a branch.'}</Empty>
        : (
          <>
          {gaveUp && <Alert tone="ok">The earlier bill was given up: it can never be issued. Make the bill again below.</Alert>}
          <InvoiceForm partner={p!} branches={branches.data} catalogue={catalogue.data} doctors={doctors.data} doctorsError={doctors.isError ? messageOf(doctors.error) : null}
            busy={busy} refused={refused}
            onIssue={(body) => {
              const requestKey = newRequestKey();
              void send(startOp(requestKey, { ...body, idempotencyKey: requestKey }));
            }} />
          </>
        )}
    </>
  );
}

function PendingSummary({ body }: { body: NewInvoice }) {
  const total = body.items.reduce((s, l) => s + l.unitPriceMinor * l.qty - (l.discountMinor ?? 0), 0);
  return (
    <div>
      Bill for {body.customer.name}: {body.items.map((l) => `${l.description} × ${l.qty}`).join('; ')} ({money(total)} before tax).
    </div>
  );
}

function InvoiceForm({ partner, branches, catalogue, doctors, doctorsError, busy, refused, onIssue }: {
  partner: Partner; branches: Branch[]; catalogue: CatalogueItem[]; doctors: ClinicDoctor[] | undefined; doctorsError: string | null;
  busy: boolean; refused: string | null; onIssue: (body: Omit<NewInvoice, 'idempotencyKey'>) => void;
}) {
  const [d, setD] = useState<InvoiceDraft>(() => ({ ...EMPTY, branchId: branches.length === 1 ? branches[0]!._id : '' }));
  // Field errors appear once the person has asked to review the bill, then follow every change.
  const [tried, setTried] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [pick, setPick] = useState('');
  const branch = branches.find((b) => b._id === d.branchId);
  const offered = catalogue.filter((i) => i.isActive && !i.adminDisabled);
  const rates = allowedGstRates(partner);
  const offeredIds = useMemo(() => new Set(offered.map((i) => i._id)), [catalogue]); // eslint-disable-line react-hooks/exhaustive-deps
  const built = useMemo(() => buildInvoice(d, partner, branch, offeredIds), [d, partner, branch, offeredIds]);
  /** Catalogue lines whose item changed price or GST since they were added (Q10 refuses them: CATALOGUE_PRICE_CHANGED). */
  const [priceNotice, setPriceNotice] = useState<string | null>(null);
  const errors: Record<string, string> = tried ? built.errors : {};
  const shown = (k: string) => errors[k] ?? (k.endsWith('.amount') ? built.errors[k] : undefined);
  const branchDoctors = (doctors ?? []).filter((x) => x.active && (x.branchIds.length === 0 || x.branchIds.includes(d.branchId)));
  const set = (patch: Partial<InvoiceDraft>) => { setD((x) => ({ ...x, ...patch })); setReviewing(false); };
  const setLine = (key: string, patch: Partial<LineDraft>) =>
    set({ lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });

  // A refusal of the issue sends the person back to the form, as typed.
  useEffect(() => { if (refused) setReviewing(false); }, [refused]);

  // The catalogue was read again (e.g. after CATALOGUE_PRICE_CHANGED): catalogue lines take the current price and GST,
  // and the person is told what changed before reviewing again.
  useEffect(() => {
    const changes: string[] = [];
    setD((x) => {
      let touched = false;
      const lines = x.lines.map((l) => {
        const cur = l.item ? catalogue.find((i) => i._id === l.item!._id) : undefined;
        if (!l.item || !cur || (cur.priceMinor === l.item.priceMinor && cur.gstRate === l.item.gstRate)) return l;
        touched = true;
        changes.push(`${cur.name} is now ${money(cur.priceMinor)} at ${cur.gstRate}% GST`);
        return { ...l, item: { ...l.item, priceMinor: cur.priceMinor, gstRate: cur.gstRate, sac: cur.sac }, price: paiseToInput(cur.priceMinor), gstRate: String(cur.gstRate) };
      });
      return touched ? { ...x, lines } : x;
    });
    if (changes.length) { setReviewing(false); setPriceNotice(`${[...new Set(changes)].join('; ')}. Review the bill before issuing it.`); }
  }, [catalogue]);

  function addFromCatalogue() {
    const it = offered.find((i) => i._id === pick);
    if (!it) { setPickError('Choose an item to add.'); return; }
    setPickError(null);
    set({ lines: [...d.lines, {
      key: lineKey(), item: { _id: it._id, name: it.name, priceMinor: it.priceMinor, gstRate: it.gstRate, sac: it.sac },
      description: it.name, sac: it.sac ?? '', qty: '1', price: paiseToInput(it.priceMinor), discount: '', gstRate: String(it.gstRate),
    }] });
    setPick('');
  }

  function review(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (Object.keys(built.errors).length === 0) setReviewing(true);
  }

  const pv = built.preview;
  const igst = !pv.sameState;
  const linkNotice = d.phone.trim() ? (
    <Alert tone="warn">
      With a phone number the bill is added to that number’s Jansetu customer account; if there is none, one is created for
      it, and the customer may get an SMS about the bill. An existing account’s details are never changed.
    </Alert>
  ) : null;

  return (
    <form className="rx-form" noValidate onSubmit={review}>
      <section className="ws-section" aria-labelledby="nb-who-h">
        <h2 id="nb-who-h">Branch and customer</h2>
        <div className="rx-form-row">
          <div className="j-field">
            <label htmlFor="nb-branch">Branch</label>
            <select id="nb-branch" value={d.branchId} aria-invalid={errors.branchId ? true : undefined} aria-describedby={errors.branchId ? 'nb-branch-error' : undefined}
              onChange={(e) => set({ branchId: e.target.value, doctorId: '' })}>
              <option value="">Choose a branch</option>
              {branches.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
            </select>
            {errors.branchId && <span id="nb-branch-error" className="j-field__error">{errors.branchId}</span>}
          </div>
          {partner.kind === 'clinic' && (
            <div className="j-field">
              <label htmlFor="nb-doctor">Doctor (optional)</label>
              <select id="nb-doctor" value={d.doctorId} disabled={!d.branchId} aria-describedby="nb-doctor-hint" onChange={(e) => set({ doctorId: e.target.value })}>
                <option value="">No doctor named</option>
                {branchDoctors.map((x) => <option key={x.doctorId} value={x.doctorId}>{x.name}{x.specialization ? ` (${x.specialization})` : ''}</option>)}
              </select>
              <span id="nb-doctor-hint" className="j-field__hint">
                {doctorsError ? `Doctors could not be loaded: ${doctorsError}` : !d.branchId ? 'Choose the branch first.' : branchDoctors.length === 0 ? 'No active doctor works at this branch.' : 'Active doctors of this clinic at this branch.'}
              </span>
            </div>
          )}
        </div>
        <div className="rx-form-row">
          <TextField label="Customer name" value={d.name} maxLength={MAX_NAME} error={errors.name} onChange={(e) => set({ name: e.target.value })} />
          <TextField label="Mobile number (optional)" inputMode="tel" value={d.phone} error={errors.phone} onChange={(e) => set({ phone: e.target.value })} />
          <TextField label="Age (optional)" inputMode="numeric" value={d.age} error={errors.age} onChange={(e) => set({ age: e.target.value.replace(/\D/g, '') })} />
          <div className="j-field">
            <label htmlFor="nb-gender">Gender (optional)</label>
            <select id="nb-gender" value={d.gender} onChange={(e) => set({ gender: e.target.value as InvoiceDraft['gender'] })}>
              <option value="">Not given</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option>
            </select>
          </div>
        </div>
        {linkNotice}
        <div className="rx-form-row">
          <TextField label="Customer GSTIN (optional)" maxLength={15} value={d.gstin} error={errors.gstin} hint="For a business customer."
            onChange={(e) => set({ gstin: e.target.value })} />
          <TextField label="Customer state code (optional)" inputMode="numeric" maxLength={2} value={d.placeOfSupply} error={errors.placeOfSupply}
            hint={`Leave empty for a customer in the branch’s state${branch?.address?.stateCode ? ` (${branch.address.stateCode})` : ''}. Another state is billed with IGST.`}
            onChange={(e) => set({ placeOfSupply: e.target.value.replace(/\D/g, '') })} />
        </div>
      </section>

      <section className="ws-section" aria-labelledby="nb-items-h">
        <h2 id="nb-items-h">Items</h2>
        {!chargesGst(partner) && <p className="ws-muted">{partner.name} is not registered for regular GST: every item is billed at 0% GST.</p>}
        {priceNotice && <Alert tone="warn">{priceNotice}</Alert>}
        <div className="ws-search">
          <div className="j-field">
            <label htmlFor="nb-pick">From the catalogue</label>
            <select id="nb-pick" value={pick} aria-describedby={pickError ? 'nb-pick-error' : undefined} onChange={(e) => { setPick(e.target.value); setPickError(null); }}>
              <option value="">{offered.length ? 'Choose an item' : 'No catalogue items offered'}</option>
              {offered.map((i) => <option key={i._id} value={i._id}>{i.name} · {money(i.priceMinor)}</option>)}
            </select>
            {pickError && <span id="nb-pick-error" className="j-field__error">{pickError}</span>}
          </div>
          <Button variant="secondary" onClick={addFromCatalogue}>Add item</Button>
          <Button variant="secondary" onClick={() => set({ lines: [...d.lines, { key: lineKey(), description: '', sac: '', qty: '1', price: '', discount: '', gstRate: '0' }] })}>
            Add a line by hand
          </Button>
        </div>
        {errors.lines && <Alert>{errors.lines}</Alert>}
        {d.lines.map((l, i) => {
          const lp = pv.lines[i];
          const title = `Line ${i + 1}${(l.item?.name ?? l.description).trim() ? `: ${(l.item?.name ?? l.description).trim()}` : ''}`;
          return (
            <fieldset key={l.key} className="ws-section ws-line">
              <legend>{title}</legend>
              <div className="rx-form-row">
                {l.item ? (
                  <p className="ws-muted">From the catalogue: {money(l.item.priceMinor)} each · GST {l.item.gstRate}%{l.item.sac ? ` · SAC ${l.item.sac}` : ''}</p>
                ) : (
                  <>
                    <TextField label="Description" value={l.description} maxLength={MAX_LINE_DESCRIPTION} error={shown(`${l.key}.description`)}
                      onChange={(e) => setLine(l.key, { description: e.target.value })} />
                    <TextField label="SAC/HSN (optional)" value={l.sac} maxLength={MAX_SAC} error={shown(`${l.key}.sac`)} onChange={(e) => setLine(l.key, { sac: e.target.value })} />
                    <TextField label="Unit price (₹)" inputMode="decimal" value={l.price} error={shown(`${l.key}.price`)} onChange={(e) => setLine(l.key, { price: e.target.value })} />
                    <div className="j-field">
                      <label htmlFor={`${l.key}-gst`}>GST rate</label>
                      <select id={`${l.key}-gst`} value={l.gstRate} onChange={(e) => setLine(l.key, { gstRate: e.target.value })}>
                        {rates.map((r) => <option key={r} value={r}>{r}%</option>)}
                      </select>
                    </div>
                  </>
                )}
                <TextField label="Quantity" inputMode="numeric" className="ws-qty" value={l.qty} error={shown(`${l.key}.qty`)}
                  onChange={(e) => setLine(l.key, { qty: e.target.value.replace(/\D/g, '') })} />
                <TextField label="Discount (₹, optional)" inputMode="decimal" value={l.discount} error={shown(`${l.key}.discount`)}
                  onChange={(e) => setLine(l.key, { discount: e.target.value })} />
              </div>
              {shown(`${l.key}.amount`) && <Alert>{shown(`${l.key}.amount`)}</Alert>}
              <div className="ws-actions">
                <span>Line amount: <strong>{lp ? money(lp.amountMinor) : '—'}</strong>{lp && lp.taxMinor ? ` + GST ${money(lp.taxMinor)}` : ''}</span>
                <Button variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => set({ lines: d.lines.filter((x) => x.key !== l.key) })}>Remove</Button>
              </div>
            </fieldset>
          );
        })}
      </section>

      <section className="ws-section" aria-labelledby="nb-total-h">
        <h2 id="nb-total-h">Expected amounts</h2>
        <p className="ws-muted">
          {d.lines.length ? `This will be ${KIND_TEXT[pv.documentKind]}${igst ? ', with IGST (another state)' : ''}. ` : ''}
          Worked out as the server does; the server’s numbers on the issued bill are final.
        </p>
        <Totals totals={pv.totals} igst={igst} label="Expected totals" />
        {(errors.bill ?? built.errors.bill) && <Alert>{errors.bill ?? built.errors.bill}</Alert>}
      </section>

      {refused && <Alert>Not issued: {refused}</Alert>}
      {!reviewing ? (
        <div className="rx-actions"><Button type="submit">Review the bill</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label="Issue the bill">
          <div className="confirm-text">
            Issue {KIND_TEXT[pv.documentKind]} for {money(pv.totals.totalMinor)} to {built.body.customer.name} from {branch?.name}?
            It gets the next number in the series and cannot be changed afterwards; it can only be cancelled.
            {built.body.customer.phone ? ' It will be added to the Jansetu account of the mobile number given.' : ''}
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => onIssue(built.body)}>Issue bill</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReviewing(false)}>Back to the bill</Button>
          </div>
        </div>
      )}
    </form>
  );
}
