import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useLocation, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import {
  allowedGstRates, ApiError, chargesGst, customerGstinProblem, INVOICE_PHONE_PATTERN, MAX_LINE_DESCRIPTION,
  MAX_LINES, MAX_NAME, MAX_PRICE_MINOR, MAX_QTY, MAX_SAC, paiseToInput, previewInvoice, rupeesToPaise, STATE_CODE_PATTERN,
  tooLongWords, type Branch, type CatalogueItem, type ClinicDoctor, type GstRate, type Invoice, type InvoiceGender, type InvoicePreview, type LinePreview,
  type NewInvoice, type NewInvoiceLine, type Page, type Partner,
} from '@jansetu/api';
import { Alert, Button, Empty, ErrorState, Loading, Parts, shared, TextField } from '@jansetu/ui';
import { PendingOpPanel } from '../../components/PendingOpPanel.tsx';
import { messageOf } from '../../errors.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { afterFailure, beginAttempt, newRequestKey, ownsKey, resolveStored, startOp, stillCurrent, wasAbandoned, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useVisitMode, useVisitPreset, type VisitPatient } from '../front/visitPatient.ts';
import { VisitPatientLine } from '../front/visitBar.tsx';
import { billLinkRefusal, billPrefillSlot, money, takeHandover, useCatalogue, useClinicDoctors, type BillHandover, type BillPrefill } from './billing.tsx';
import { Totals, type IssuedNotice } from './InvoiceScreen.tsx';
import { NoSuchPartner, scopeIdentity, useBranches, usePartnerScope, useWorkspacePartner, type ScopeContext } from './scope.tsx';
import { t, type PartnerKey } from '../../i18n/partner/index.ts';

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
  /**
   * Q14 / r12: the clinic appointment or lab front-desk booking this bill is for. While it is linked, its branch, doctor
   * and customer (the account holder: mobile, and the name when one was given) are fixed as booked.
   */
  link?: { kind: 'appointment' | 'lab_booking'; id: string; label: string; nameFixed: boolean; phoneFixed: boolean };
}

/** The bill type in a sentence. */
/**
 * WQ11d: a line's GST as the server charges it: within a state CGST and SGST each at half the rate, each rounded on its
 * own (so 333 paise at 5% is ₹0.08 + ₹0.08 = ₹0.16, not ₹0.17); another state, IGST rounded once.
 */
function lineAmount(lp: LinePreview | undefined): ReactNode[] {
  const amount = <strong>{lp ? money(lp.amountMinor) : '—'}</strong>;
  if (!lp || !lp.taxMinor) return t.rich('newInvoice.line.amount', { amount });
  if (lp.halfMinor === undefined) return t.rich('newInvoice.line.amountIgst', { amount, tax: money(lp.taxMinor) });
  return t.rich('newInvoice.line.amountGst', { amount, tax: money(lp.halfMinor * 2), half: money(lp.halfMinor) });
}

const KIND_KEY = {
  tax_invoice: 'newInvoice.kind.tax_invoice', bill_of_supply: 'newInvoice.kind.bill_of_supply', commercial_invoice: 'newInvoice.kind.commercial_invoice',
} as const satisfies Record<InvoicePreview['documentKind'], PartnerKey>;

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
  if (!d.branchId || !branch) errors.branchId = t('newInvoice.error.branch');
  const name = d.name.trim();
  if (!name) errors.name = t('newInvoice.error.name');
  else if (name.length > MAX_NAME) errors.name = tooLongWords(MAX_NAME);
  const phone = d.phone.replace(/[\s-]/g, '');
  if ((phone || d.link?.kind === 'appointment') && !INVOICE_PHONE_PATTERN.test(phone)) errors.phone = t('newInvoice.error.phone');
  const age = d.age.trim();
  if (age && (!/^\d{1,3}$/.test(age) || Number(age) > 150)) errors.age = t('newInvoice.error.age');
  const gstin = d.gstin.trim().toUpperCase();
  const gstinProblem = customerGstinProblem(gstin);
  if (gstinProblem) errors.gstin = gstinProblem;
  const pos = d.placeOfSupply.trim();
  if (pos && !STATE_CODE_PATTERN.test(pos)) errors.placeOfSupply = t('newInvoice.error.placeOfSupply');

  if (d.lines.length === 0) errors.lines = t('newInvoice.error.noLines');
  else if (d.lines.length > MAX_LINES) errors.lines = t('newInvoice.error.tooManyLines', { max: MAX_LINES });
  const items: NewInvoiceLine[] = d.lines.map((l) => {
    const e = (field: string, text: string) => { errors[`${l.key}.${field}`] = text; };
    const description = (l.item?.name ?? l.description).trim();
    if (!description) e('description', t('newInvoice.error.description'));
    else if (description.length > MAX_LINE_DESCRIPTION) e('description', tooLongWords(MAX_LINE_DESCRIPTION));
    const sac = (l.item ? l.item.sac ?? '' : l.sac).trim();
    if (sac.length > MAX_SAC) e('sac', tooLongWords(MAX_SAC));
    const qty = /^\d{1,5}$/.test(l.qty.trim()) ? Number(l.qty.trim()) : NaN;
    if (!(qty >= 1 && qty <= MAX_QTY)) e('qty', t('newInvoice.error.qty', { max: MAX_QTY }));
    const price = l.item ? l.item.priceMinor : rupeesToPaise(l.price);
    if (price === null) e('price', l.price.trim() ? t('newInvoice.error.priceFormat') : t('newInvoice.error.price'));
    else if (price > MAX_PRICE_MINOR) e('price', t('newInvoice.error.priceTooHigh'));
    const discount = l.discount.trim() ? rupeesToPaise(l.discount) : 0;
    if (discount === null) e('discount', t('newInvoice.error.discount'));
    const gstRate = (l.item ? l.item.gstRate : Number(l.gstRate)) as GstRate;
    if (!l.item && !rates.includes(gstRate)) e('gstRate', t('newInvoice.error.gstRate'));
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
    if (l.item && offeredIds && !offeredIds.has(l.item._id)) errors[`${l.key}.amount`] = t('newInvoice.error.notOffered', { name: l.item.name });
  });
  if (branch && !stateCode) errors.branchId = t('newInvoice.error.stateCode');
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
      ...(d.link ? (d.link.kind === 'appointment' ? { appointmentId: d.link.id } : { labBookingId: d.link.id }) : {}),
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
  // Q14: handed over once by "Create bill" on a clinic appointment (session memory only).
  const prefillSlot = billPrefillSlot(scopeIdentity(ctx));
  const location = useLocation();
  const [prefill] = useState(() => takeHandover(memory.get<BillHandover>(prefillSlot), location.state));
  // WQ55: opened from + New, the visit's patient (handed over once). WQ55b: a visit's bill (from + New, or straight from
  // its desk booking) is the short one, and its bill page too.
  const visit = useVisitPreset();
  const simple = !!visit || !!prefill?.simple;
  useVisitMode(simple);
  // WQ55c: Home from a visit's bill not issued yet asks first (the walk-in would stay unbilled); Stay is the main answer.
  const leaving = useBlocker(({ nextLocation }) => simple && nextLocation.pathname === '/');
  // Read once: whatever was handed over (also a handover this navigation does not name) is cleared now.
  useEffect(() => { memory.delete(prefillSlot); }, [memory, prefillSlot]);

  /**
   * Whether an answer started for `op` may still act: this page is on screen AND the stored bill is still exactly `op`
   * (same key, same attempt). Otherwise a newer attempt (here or on a page opened since) owns the state, and an obsolete
   * answer must leave it — and its reload marker — intact: resending it replays the same bill.
   */
  const owns = (op: Pending) => mounted.current && stillCurrent(memory.get<Pending>(slot), op);
  /**
   * WQ11b: an answer about the key itself (a by-key lookup, a give-up's `used` or `abandoned`) settles what this page shows
   * when the stored bill is this key or is gone. After leaving mid-send and coming back, the first page's late answer
   * removes the stored bill while this page still shows it; "Give up" must then still act on the server's word.
   */
  const ownsTheKey = (op: Pending) => mounted.current && ownsKey(memory.get<Pending>(slot), op.requestKey);

  /** `op` produced this bill (answer, replay, lookup or give-up `used`): end it, and only it, then open the bill. */
  const issued = (inv: Invoice, op: Pending, earlier = false) => {
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'invoices'] });
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-appointments'] });
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'lab-bookings'] });
    void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'lab-booking'] });
    if (earlier ? !ownsTheKey(op) : !owns(op)) return;
    resolveStored(memory, slot, op.requestKey);
    const requestKey = op.requestKey;
    setPendingState((cur) => (cur && cur.requestKey !== requestKey ? cur : undefined));
    // What happened, as data: the bill page words it (in the language showing then).
    const notice: IssuedNotice = { serial: inv.serial, earlier, linked: !!inv.customer?.userId };
    navigate(`${ctx.link('invoices')}/${inv._id}`, { state: { issued: notice, ...(simple ? { simple: true } : {}) } });
  };

  /** Sends exactly `p` (same key, same content). Only success, or a definite refusal of its FIRST attempt, ends it. */
  async function send(p: Pending) {
    const attempt = beginAttempt(p);
    setBusy(true);
    setRefused(null);
    setGaveUp(false);
    setPending(attempt);
    try {
      issued(await ctx.billing.createInvoice(attempt.body), attempt);
    } catch (err) {
      // Q10: a catalogue line no longer matches the catalogue: read it again so the form shows the change.
      if (err instanceof ApiError && err.code === 'CATALOGUE_PRICE_CHANGED') void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'catalogue'] });
      // Q14: another bill was issued for the appointment meanwhile: the desk rows show it once read again.
      if (err instanceof ApiError && err.code === 'APPOINTMENT_ALREADY_BILLED') void queryClient.invalidateQueries({ queryKey: [...ctx.key, 'clinic-appointments'] });
      if (!stillCurrent(memory.get<Pending>(slot), attempt)) return;
      // WQ11b: the key was given up (e.g. in another tab, or on a page left earlier): no bill was or can ever be issued
      // with it, whatever attempt this is. It settles, and the form opens again.
      if (wasAbandoned(err)) {
        if (mounted.current) {
          setPending(undefined);
          setRefused(t('newInvoice.givenUp'));
        } else memory.delete(slot);
        return;
      }
      // Customer linking is checked before anything is written; on a first attempt that refusal is definite too.
      const linkingOff = err instanceof ApiError && err.code === 'CUSTOMER_LINKING_UNAVAILABLE' && attempt.attempts === 1 && !attempt.uncertain;
      const next = linkingOff ? null : afterFailure(attempt, err, messageOf(err));
      if (mounted.current) {
        setPending(next ?? undefined);
        if (!next) setRefused((err instanceof ApiError && billLinkRefusal(err.code)) || messageOf(err));
      } else if (next) memory.set(slot, next); else memory.delete(slot);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const p = partner.data;
  return (
    <>
      <Link className="ws-back" to={ctx.link('invoices')}><ArrowLeft size={16} aria-hidden="true" /> {t('newInvoice.backToBills')}</Link>
      {leaving.state === 'blocked' && (
        <div className="confirm" role="alertdialog" aria-labelledby="nb-leave-h">
          <p id="nb-leave-h"><strong>{t('newInvoice.leaveTitle')}</strong></p>
          <div className="confirm-actions">
            <Button autoFocus onClick={() => leaving.reset()}>{t('newInvoice.stay')}</Button>
            <Button variant="secondary" onClick={() => leaving.proceed()}>{t('newInvoice.leave')}</Button>
          </div>
        </div>
      )}
      <PageHeading title={t('newInvoice.title')}>
        {ctx.adminHome ? <>{p?.name == null ? t('scope.managingThis') : t('scope.managing', { name: p.name })} </> : null}
        {p?.name == null ? t('newInvoice.seriesUnnamed') : t('newInvoice.series', { name: p.name })}
      </PageHeading>
      {pending && !(busy && pending.attempts === 1 && !pending.uncertain) ? (
        <PendingOpPanel key={pending.attempts} label={t('newInvoice.unconfirmed')} op={pending} busy={busy} onResend={() => void send(pending)}
          fetchPage={keyLookup(ctx, pending.requestKey)}
          onFound={(inv) => issued(inv, pending, true)}
          // Q10: giving up is decided by the server: `abandoned` = this bill can never be issued; `used` = here it is.
          abandon={async () => {
            const r = await ctx.billing.abandonInvoiceKey(pending.requestKey);
            return { state: r.state, record: r.invoice ? { ...r.invoice, requestKey: r.invoice.idempotencyKey, createdAt: r.invoice.issuedAt } : undefined };
          }}
          abandonWhenNotFound abandonLabel={t('newInvoice.giveUp')}
          onDiscard={() => {
            // Given up on the server (the server's word on this key): acts unless another bill is stored since.
            if (!ownsTheKey(pending)) return;
            const k = pending.requestKey;
            resolveStored(memory, slot, k);
            setPendingState((cur) => (cur && cur.requestKey !== k ? cur : undefined));
            setGaveUp(true);
          }}
          summary={pending.restored ? null : <PendingSummary body={pending.body} />} />
      ) : partner.isPending || branches.isPending || catalogue.isPending ? <Loading label={shared('state.loading')} />
        : partner.isError ? <ErrorState message={messageOf(partner.error)} onRetry={() => void partner.refetch()} />
        : branches.isError ? <ErrorState message={messageOf(branches.error)} onRetry={() => void branches.refetch()} />
        : catalogue.isError ? <ErrorState message={messageOf(catalogue.error)} onRetry={() => void catalogue.refetch()} />
        : branches.data.length === 0 ? <Empty title={t('newInvoice.noBranch.title')}>{ctx.actor.role === 'owner' ? t('newInvoice.noBranch.owner') : t('newInvoice.noBranch.other')}</Empty>
        : (
          <>
          {gaveUp && <Alert tone="ok">{t('newInvoice.gaveUp')}</Alert>}
          <InvoiceForm partner={p!} branches={branches.data} catalogue={catalogue.data} doctors={doctors.data} doctorsError={doctors.isError ? messageOf(doctors.error) : null}
            busy={busy} refused={refused} prefill={prefill} visit={visit} simple={simple}
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
      {t('newInvoice.pendingSummary', { name: body.customer.name, items: body.items.map((l) => `${l.description} × ${l.qty}`).join('; '), total: money(total) })}
    </div>
  );
}

/** Match a full name without splitting letters, combining marks or digits. */
export const wholeWords = (name: string) => new RegExp(`(^|[^\\p{L}\\p{M}\\p{N}])${name.normalize('NFC').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}($|[^\\p{L}\\p{M}\\p{N}])`, 'iu');

const offeredById = (catalogue: readonly CatalogueItem[], id: string) => catalogue.find((i) => i._id === id && i.isActive && !i.adminDisabled);

/** A bill line from a catalogue item (its name, price and GST rate kept; only quantity and discount change). */
const catalogueLine = (it: CatalogueItem): LineDraft => ({
  key: lineKey(), item: { _id: it._id, name: it.name, priceMinor: it.priceMinor, gstRate: it.gstRate, sac: it.sac },
  description: it.name, sac: it.sac ?? '', qty: '1', price: paiseToInput(it.priceMinor), discount: '', gstRate: String(it.gstRate),
});

function InvoiceForm({ partner, branches, catalogue, doctors, doctorsError, busy, refused, prefill, visit, simple, onIssue }: {
  partner: Partner; branches: Branch[]; catalogue: CatalogueItem[]; doctors: ClinicDoctor[] | undefined; doctorsError: string | null;
  busy: boolean; refused: string | null; prefill?: BillPrefill; visit: VisitPatient | null; simple: boolean; onIssue: (body: Omit<NewInvoice, 'idempotencyKey'>) => void;
}) {
  const [d, setD] = useState<InvoiceDraft>(() => (prefill
    ? { ...EMPTY, branchId: prefill.branchId, doctorId: prefill.doctorId, name: prefill.name, phone: prefill.phone,
      link: { ...prefill.link, label: prefill.label, nameFixed: !!prefill.name.trim(), phoneFixed: !!prefill.phone.trim() },
      // WQ55b: the booked tests, at today's catalogue price (one the catalogue no longer offers is left out).
      lines: [...(prefill.items ?? []).flatMap(({ id }) => {
        const it = offeredById(catalogue, id);
        return it ? [catalogueLine(it)] : [];
      }), ...(prefill.handLines ?? []).map((l): LineDraft => {
        // Only a catalogue line that names this doctor and matches the booked fee can replace the hand line.
        const named = l.doctor ? wholeWords(l.doctor) : null;
        const item = named && catalogue.find((i) => i.kind === 'consultation' && i.isActive && !i.adminDisabled
          && i.priceMinor === l.priceMinor && named.test(i.name.normalize('NFC')));
        return item ? catalogueLine(item)
          : { key: lineKey(), description: l.description, sac: '', qty: '1', price: paiseToInput(l.priceMinor), discount: '', gstRate: '0' };
      })] }
    // WQ55: a bill opened from + New is the account holder's (as a desk booking's bill): a family member's is in the phone
    // owner's name (typed on + New, else typed here).
    : { ...EMPTY, branchId: branches.length === 1 ? branches[0]!._id : '',
      ...(visit ? { name: visit.family ? visit.family.holderName : visit.name, phone: visit.phone } : {}) }));
  const linked = !!d.link;
  // WQ55c: booked tests the catalogue no longer offers are said by name (fewer lines than tests booked).
  const [missing] = useState(() => (prefill?.items ?? []).filter(({ id }) => !offeredById(catalogue, id)).map((x) => x.name));
  // WQ55b: a visit's bill with no name yet (a family member's, the owner not named on + New) asks for the owner's.
  const [nameAsked] = useState(() => simple && !d.name.trim());
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
        changes.push(t('newInvoice.priceChanged', { name: cur.name, price: money(cur.priceMinor), rate: cur.gstRate }));
        return { ...l, item: { ...l.item, priceMinor: cur.priceMinor, gstRate: cur.gstRate, sac: cur.sac }, price: paiseToInput(cur.priceMinor), gstRate: String(cur.gstRate) };
      });
      return touched ? { ...x, lines } : x;
    });
    if (changes.length) { setReviewing(false); setPriceNotice(t('newInvoice.priceNotice', { changes: [...new Set(changes)].join('; ') })); }
  }, [catalogue]);

  function addFromCatalogue() {
    const it = offered.find((i) => i._id === pick);
    if (!it) { setPickError(t('newInvoice.chooseItem')); return; }
    setPickError(null);
    set({ lines: [...d.lines, catalogueLine(it)] });
    setPick('');
  }

  function review(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (Object.keys(built.errors).length > 0) return;
    // WQ55b: a visit's short bill is issued at once (its button names the total).
    if (simple) onIssue(built.body); else setReviewing(true);
  }

  const pv = built.preview;
  const igst = !pv.sameState;
  const linkNotice = d.phone.trim() ? (
    <Alert tone="warn">{t('newInvoice.linkNotice')}</Alert>
  ) : null;

  // WQ55c: a visit's bill offers only tests not on it yet.
  const pickable = simple ? offered.filter((i) => !d.lines.some((l) => l.item?._id === i._id)) : offered;
  const picker = (
    <div className="ws-search">
      <div className="j-field">
        <label htmlFor="nb-pick">{t('newInvoice.fromCatalogue')}</label>
        <select id="nb-pick" value={pick} aria-describedby={pickError ? 'nb-pick-error' : undefined} onChange={(e) => { setPick(e.target.value); setPickError(null); }}>
          <option value="">{pickable.length ? t('newInvoice.chooseAnItem') : t('newInvoice.noCatalogue')}</option>
          {pickable.map((i) => <option key={i._id} value={i._id}>{i.name} · {money(i.priceMinor)}</option>)}
        </select>
        {pickError && <span id="nb-pick-error" className="j-field__error">{pickError}</span>}
      </div>
      <Button variant="secondary" onClick={addFromCatalogue}>{t('newInvoice.addItem')}</Button>
      {/* A hand-written line needs its own fields: the full bill only. */}
      {!simple && (
        <Button variant="secondary" onClick={() => set({ lines: [...d.lines, { key: lineKey(), description: '', sac: '', qty: '1', price: '', discount: '', gstRate: '0' }] })}>
          {t('newInvoice.addLine')}
        </Button>
      )}
    </div>
  );

  return (
    <form className="rx-form" noValidate onSubmit={review}>
      <section className="ws-section" aria-labelledby="nb-who-h">
        <h2 id="nb-who-h">{t('newInvoice.who')}</h2>
        {visit && <VisitPatientLine patient={visit} canChange={!busy && !reviewing} />}
        {visit?.family && <p className="ws-muted">{t('newInvoice.visitFamily')}</p>}
        {d.link && (d.link.kind === 'appointment' ? (
          <div className="ws-actions" role="group" aria-label={t('newInvoice.appointment')}>
            <span>{t('newInvoice.forAppointment', { label: d.link.label })}</span>
            {!simple && <Button variant="ghost" onClick={() => set({ link: undefined })}>{t('newInvoice.notForAppointment')}</Button>}
          </div>
        ) : (
          <div className="ws-actions" role="group" aria-label={t('newInvoice.labBooking')}>
            <span>{t(d.link.phoneFixed ? 'newInvoice.forLabBooking' : 'newInvoice.forLabBookingPhone', { label: d.link.label })}</span>
            {!simple && <Button variant="ghost" onClick={() => set({ link: undefined })}>{t('newInvoice.notForBooking')}</Button>}
          </div>
        ))}
        {(!simple || (!linked && branches.length > 1)) && (
          <div className="rx-form-row">
            <div className="j-field">
              <label htmlFor="nb-branch">{t('newInvoice.branch')}</label>
              <select id="nb-branch" value={d.branchId} disabled={linked} aria-invalid={errors.branchId ? true : undefined} aria-describedby={errors.branchId ? 'nb-branch-error' : undefined}
                onChange={(e) => set({ branchId: e.target.value, doctorId: '' })}>
                <option value="">{t('newInvoice.chooseBranch')}</option>
                {branches.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
              </select>
              {errors.branchId && <span id="nb-branch-error" className="j-field__error">{errors.branchId}</span>}
            </div>
            {partner.kind === 'clinic' && (
              <div className="j-field">
                <label htmlFor="nb-doctor">{t('newInvoice.doctor')}</label>
                <select id="nb-doctor" value={d.doctorId} disabled={!d.branchId || linked} aria-describedby="nb-doctor-hint" onChange={(e) => set({ doctorId: e.target.value })}>
                  <option value="">{t('newInvoice.noDoctor')}</option>
                  {branchDoctors.map((x) => <option key={x.doctorId} value={x.doctorId}>{x.name}{x.specialization ? ` (${x.specialization})` : ''}</option>)}
                </select>
                <span id="nb-doctor-hint" className="j-field__hint">
                  {doctorsError ? t('newInvoice.doctorsFailed', { reason: doctorsError }) : !d.branchId ? t('newInvoice.doctorBranchFirst')
                    : branchDoctors.length === 0 ? t('newInvoice.noDoctorHere') : t('newInvoice.doctorsHere')}
                </span>
              </div>
            )}
          </div>
        )}
        <div className="rx-form-row">
          <TextField label={simple ? t('newInvoice.nameOnBill') : t('newInvoice.name')} hint={nameAsked ? t('newInvoice.nameOnBillHint') : undefined}
            value={d.name} maxLength={MAX_NAME} error={errors.name} readOnly={!!d.link?.nameFixed}
            onChange={(e) => set({ name: e.target.value })} />
          <TextField label={d.link ? t('newInvoice.mobile') : t('newInvoice.mobileOptional')} inputMode="tel" value={d.phone} error={errors.phone} readOnly={!!d.link?.phoneFixed}
            onChange={(e) => set({ phone: e.target.value })} />
          {!simple && (
            <>
              <TextField label={t('newInvoice.age')} inputMode="numeric" value={d.age} error={errors.age} onChange={(e) => set({ age: e.target.value.replace(/\D/g, '') })} />
              <div className="j-field">
                <label htmlFor="nb-gender">{t('newInvoice.gender')}</label>
                <select id="nb-gender" value={d.gender} onChange={(e) => set({ gender: e.target.value as InvoiceDraft['gender'] })}>
                  <option value="">{t('newInvoice.gender.none')}</option><option value="female">{t('newInvoice.gender.female')}</option>
                  <option value="male">{t('newInvoice.gender.male')}</option><option value="other">{t('newInvoice.gender.other')}</option>
                </select>
              </div>
            </>
          )}
        </div>
        {!simple ? (
          <>
            {linkNotice}
            <div className="rx-form-row">
              <TextField label={t('newInvoice.gstin')} maxLength={15} value={d.gstin} error={errors.gstin} hint={t('newInvoice.gstinHint')}
                onChange={(e) => set({ gstin: e.target.value })} />
              <TextField label={t('newInvoice.stateCode')} inputMode="numeric" maxLength={2} value={d.placeOfSupply} error={errors.placeOfSupply}
                hint={branch?.address?.stateCode ? t('newInvoice.stateCodeHintCode', { code: branch.address.stateCode }) : t('newInvoice.stateCodeHint')}
                onChange={(e) => set({ placeOfSupply: e.target.value.replace(/\D/g, '') })} />
            </div>
          </>
        ) : (
          // WQ55b: a visit's short bill: age, gender, GSTIN and state code behind More details (as before when opened).
          <details className="more-details">
            <summary>{t('newInvoice.moreDetails')}</summary>
            <div className="rx-form-row">
              <TextField label={t('newInvoice.age')} inputMode="numeric" value={d.age} error={errors.age} onChange={(e) => set({ age: e.target.value.replace(/\D/g, '') })} />
              <div className="j-field">
                <label htmlFor="nb-gender">{t('newInvoice.gender')}</label>
                <select id="nb-gender" value={d.gender} onChange={(e) => set({ gender: e.target.value as InvoiceDraft['gender'] })}>
                  <option value="">{t('newInvoice.gender.none')}</option><option value="female">{t('newInvoice.gender.female')}</option>
                  <option value="male">{t('newInvoice.gender.male')}</option><option value="other">{t('newInvoice.gender.other')}</option>
                </select>
              </div>
            </div>
            {linkNotice}
            <div className="rx-form-row">
              <TextField label={t('newInvoice.gstin')} maxLength={15} value={d.gstin} error={errors.gstin} hint={t('newInvoice.gstinHint')}
                onChange={(e) => set({ gstin: e.target.value })} />
              <TextField label={t('newInvoice.stateCode')} inputMode="numeric" maxLength={2} value={d.placeOfSupply} error={errors.placeOfSupply}
                hint={branch?.address?.stateCode ? t('newInvoice.stateCodeHintCode', { code: branch.address.stateCode }) : t('newInvoice.stateCodeHint')}
                onChange={(e) => set({ placeOfSupply: e.target.value.replace(/\D/g, '') })} />
            </div>
          </details>
        )}
      </section>

      <section className="ws-section" aria-labelledby="nb-items-h">
        <h2 id="nb-items-h">{t('newInvoice.items')}</h2>
        {!chargesGst(partner) && <p className="ws-muted">{simple ? t('newInvoice.noGstShort') : t('newInvoice.noGst', { name: partner.name })}</p>}
        {priceNotice && <Alert tone="warn">{priceNotice}</Alert>}
        {missing.length > 0 && <Alert tone="warn">{t('newInvoice.missingTests', { tests: missing.join(', ') })}</Alert>}
        {!simple && picker}
        {errors.lines && <Alert>{errors.lines}</Alert>}
        {simple ? (
          <ul className="ws-list bill-lines" aria-label={t('newInvoice.items')}>
            {d.lines.map((l, i) => (
              <li key={l.key}>
                <span>{`${(l.item?.name ?? l.description).trim()} · ${pv.lines[i] ? money(pv.lines[i]!.amountMinor) : '—'}`}</span>
                {/* WQ57b: the only line (a visit's fee or test) is not offered for removal. */}
                {d.lines.length > 1 && (
                  <Button variant="ghost" aria-label={t('newInvoice.removeLine', { n: i + 1 })} onClick={() => set({ lines: d.lines.filter((x) => x.key !== l.key) })}>
                    {shared('action.remove')}
                  </Button>
                )}
                {shown(`${l.key}.amount`) && <Alert>{shown(`${l.key}.amount`)}</Alert>}
              </li>
            ))}
          </ul>
        ) : null}
        {/* WQ55c: in a visit the bill's lines come first; another test is a small link that opens the catalogue. */}
        {simple && (
          <details className="more-details">
            <summary>{partner.kind === 'clinic' ? t('newInvoice.addAnotherItem') : t('newInvoice.addAnother')}</summary>
            {picker}
          </details>
        )}
        {!simple && d.lines.map((l, i) => {
          const lp = pv.lines[i];
          const named = (l.item?.name ?? l.description).trim();
          const title = named ? t('newInvoice.lineTitleNamed', { n: i + 1, name: named }) : t('newInvoice.lineTitle', { n: i + 1 });
          return (
            <fieldset key={l.key} className="ws-section ws-line">
              <legend>{title}</legend>
              <div className="rx-form-row">
                {l.item ? (
                  <p className="ws-muted">
                    {l.item.sac ? t('newInvoice.catalogueLineSac', { price: money(l.item.priceMinor), rate: l.item.gstRate, sac: l.item.sac })
                      : t('newInvoice.catalogueLine', { price: money(l.item.priceMinor), rate: l.item.gstRate })}
                  </p>
                ) : (
                  <>
                    <TextField label={t('newInvoice.description')} value={l.description} maxLength={MAX_LINE_DESCRIPTION} error={shown(`${l.key}.description`)}
                      onChange={(e) => setLine(l.key, { description: e.target.value })} />
                    <TextField label={t('newInvoice.sac')} value={l.sac} maxLength={MAX_SAC} error={shown(`${l.key}.sac`)} onChange={(e) => setLine(l.key, { sac: e.target.value })} />
                    <TextField label={t('newInvoice.unitPrice')} inputMode="decimal" value={l.price} error={shown(`${l.key}.price`)} onChange={(e) => setLine(l.key, { price: e.target.value })} />
                    <div className="j-field">
                      <label htmlFor={`${l.key}-gst`}>{t('newInvoice.gstRate')}</label>
                      <select id={`${l.key}-gst`} value={l.gstRate} onChange={(e) => setLine(l.key, { gstRate: e.target.value })}>
                        {rates.map((r) => <option key={r} value={r}>{r}%</option>)}
                      </select>
                    </div>
                  </>
                )}
                <TextField label={t('newInvoice.quantity')} inputMode="numeric" className="ws-qty" value={l.qty} error={shown(`${l.key}.qty`)}
                  onChange={(e) => setLine(l.key, { qty: e.target.value.replace(/\D/g, '') })} />
                <TextField label={t('newInvoice.discount')} inputMode="decimal" value={l.discount} error={shown(`${l.key}.discount`)}
                  onChange={(e) => setLine(l.key, { discount: e.target.value })} />
              </div>
              {shown(`${l.key}.amount`) && <Alert>{shown(`${l.key}.amount`)}</Alert>}
              <div className="ws-actions">
                <span><Parts of={lineAmount(lp)} /></span>
                <Button variant="ghost" aria-label={t('newInvoice.removeLine', { n: i + 1 })} onClick={() => set({ lines: d.lines.filter((x) => x.key !== l.key) })}>
                  {shared('action.remove')}
                </Button>
              </div>
            </fieldset>
          );
        })}
      </section>

      {simple ? (
        <section className="ws-section" aria-labelledby="nb-total-h">
          <h2 id="nb-total-h" className="bill-total">{t('newInvoice.totalIs', { total: money(pv.totals.totalMinor) })}</h2>
          <details className="more-details">
            <summary>{t('newInvoice.moreDetails')}</summary>
            <Totals totals={pv.totals} igst={igst} label={t('newInvoice.expectedTotals')} />
          </details>
          {(errors.bill ?? built.errors.bill) && <Alert>{errors.bill ?? built.errors.bill}</Alert>}
        </section>
      ) : (
      <section className="ws-section" aria-labelledby="nb-total-h">
        <h2 id="nb-total-h">{t('newInvoice.expected')}</h2>
        <p className="ws-muted">
          {!d.lines.length ? t('newInvoice.expected.none')
            : t(igst ? 'newInvoice.expected.kindIgst' : 'newInvoice.expected.kind', { kind: t(KIND_KEY[pv.documentKind]) })}
        </p>
        <Totals totals={pv.totals} igst={igst} label={t('newInvoice.expectedTotals')} />
        {(errors.bill ?? built.errors.bill) && <Alert>{errors.bill ?? built.errors.bill}</Alert>}
      </section>
      )}

      {refused && <Alert>{t('newInvoice.notIssued', { reason: refused })}</Alert>}
      {simple ? (
        <div className="rx-actions"><Button type="submit" busy={busy}>{t('newInvoice.issueFor', { total: money(pv.totals.totalMinor) })}</Button></div>
      ) : !reviewing ? (
        <div className="rx-actions"><Button type="submit">{t('newInvoice.review')}</Button></div>
      ) : (
        <div className="confirm" role="group" aria-label={t('newInvoice.issueGroup')}>
          <div className="confirm-text">
            {t(!d.link ? 'newInvoice.confirm.issue' : d.link.kind === 'appointment' ? 'newInvoice.confirm.issueAppointment' : 'newInvoice.confirm.issueLab', {
              kind: t(KIND_KEY[pv.documentKind]), total: money(pv.totals.totalMinor), name: built.body.customer.name, branch: branch?.name ?? '',
              link: d.link?.label ?? '',
            })}
            {' '}{t('newInvoice.confirm.final')}
            {built.body.customer.phone ? <> {t('newInvoice.confirm.linked')}</> : null}
          </div>
          <div className="confirm-actions">
            <Button busy={busy} onClick={() => onIssue(built.body)}>{t('newInvoice.issue')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setReviewing(false)}>{t('newInvoice.backToBill')}</Button>
          </div>
        </div>
      )}
    </form>
  );
}
