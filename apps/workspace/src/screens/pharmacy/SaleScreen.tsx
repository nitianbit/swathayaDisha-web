import './sale.css';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ApiError, COUNTER_PAYMENTS, formatExpiry, inventoryApi, MAX_CUSTOMER_NAME, MAX_SALE_SEARCH, medicineName, pharmacyOrdersApi, pharmacyProfileApi,
  pharmacySaleApi, saleCandidates, saleRequestBody, sellableQty, usableCustomers, walkInProblems,
  type CounterPayment, type InventoryItem, type PharmacyOrder, type SaleBody,
} from '@jansetu/api';
import { formatRupees } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, shared, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/sale/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey, startOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { canMarkPaid, orderLabel, paymentWaitsForPharmacist } from './orderLabels.ts';
import { CheckPanel, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { PHARMACY_PROFILE_KEY } from './RxReviewScreen.tsx';

/**
 * WQ50: Pharmacy › New sale, one screen for a counter sale: the customer (one this pharmacy already has, or a walk-in by
 * name and phone, linked with the patient's agreement), medicines from active stock, an optional prescription, then the
 * one primary action, "Create sale" (an owned request: r35 has no request key for it, so a lost answer is looked for
 * among this customer's in-store orders that did not exist before it was sent, never sent again). WQ50b: the created
 * sale has its own page (`/pharmacy/sale/:orderId`): its bill (printable) and the counter payment (cash or UPI, marked
 * paid); an order with a prescription medicine waits for the pharmacist.
 */
export function SaleScreen() {
  const pharmacyId = usePharmacyId();
  return (
    <>
      <PageHeading title={t('title')}>{t('intro')}</PageHeading>
      <SaleForm key={pharmacyId} pharmacyId={pharmacyId} />
    </>
  );
}

// ── The sale ──

type Customer = { kind: 'existing'; id: string; label: string } | { kind: 'walkin' };
interface Line { medicineId: string; name: string; qty: string; max: number; price: number | null }
type Errors = Partial<Record<'customer' | 'name' | 'phone' | 'consent' | 'lines', string>>;
/** The stored request (this tab's memory only): the sale, and the customer's in-store orders that existed before it. */
type PendingSale = SaleBody & { before: string[] };

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code ?? null : null);
/** The server's refusals of a sale this page words (pharmacyOrders, pharmacyCustomers, the pharmacy guard). */
const REFUSALS = ['INSUFFICIENT_BATCH_STOCK', 'INSUFFICIENT_STOCK', 'MEDICINE_NOT_AVAILABLE', 'PRICE_NOT_AVAILABLE', 'DUPLICATE_ORDER_MEDICINE',
  'CUSTOMER_NOT_LINKED', 'USER_NOT_FOUND', 'CONSENT_REQUIRED', 'FORBIDDEN', 'PRESCRIPTION_CHECKOUT_UNAVAILABLE', 'PRESCRIPTION_REVIEW_REQUIRED',
  'MARK_PAID_NOT_ALLOWED', 'ORDER_TERMINAL', 'ORDER_CANCEL_PENDING', 'ORDER_ALREADY_REFUNDED'] as const;
type Refusal = (typeof REFUSALS)[number];
/** A refusal in words (the server's code), else the server's message. */
function saleWords(err: unknown): string {
  const code = codeOf(err);
  return (REFUSALS as readonly (string | null)[]).includes(code) ? t(`refusal.${code as Refusal}`) : messageOf(err);
}
const qtyOf = (l: Line) => (/^\d{1,5}$/.test(l.qty.trim()) ? Number(l.qty.trim()) : NaN);
/** After a lost answer, Forget only once a check found nothing at least 30 s after the attempt, and not on the first check. */
const FORGET_AFTER_MS = 30_000;

function SaleForm({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const sale = pharmacySaleApi(api);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { perform, busy } = useOneAtATime('order');
  const { op, send, settle } = useOwnedOp<PendingSale>(`pharmacy-sale:${pharmacyId}`);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [walkIn, setWalkIn] = useState({ name: '', phone: '', consent: false });
  const [lines, setLines] = useState<Line[]>([]);
  const [prescriptions, setPrescriptions] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [review, setReview] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [checks, setChecks] = useState({ count: 0, lastAt: 0 });

  const linesOk = lines.length > 0 && lines.every((l) => Number.isInteger(qtyOf(l)) && qtyOf(l) >= 1 && qtyOf(l) <= l.max);
  const estimate = lines.reduce((a, l) => a + (Number.isFinite(qtyOf(l)) && l.price !== null ? qtyOf(l) * l.price : 0), 0);
  const unpriced = lines.some((l) => l.price === null);
  const shownCustomer = customer?.kind === 'existing' ? customer.label : customer?.kind === 'walkin' ? `${walkIn.name.trim()} · ${walkIn.phone.trim()}` : '';
  const done = (orderId: string) => navigate(`/pharmacy/sale/${orderId}`, { replace: true });

  function check(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    if (uploading) return;
    const errs: Errors = {};
    if (!customer) errs.customer = t('customer.required');
    if (customer?.kind === 'walkin') {
      const w = walkInProblems(walkIn);
      if (w.name) errs.name = t('walkIn.nameError', { max: MAX_CUSTOMER_NAME });
      if (w.phone) errs.phone = t('walkIn.phoneError');
      if (w.consent) errs.consent = t('walkIn.consentError');
    }
    if (!lines.length) errs.lines = t('lines.required');
    else if (!linesOk) errs.lines = t('lines.qtyError');
    setErrors(errs);
    setReview(Object.keys(errs).length === 0);
  }

  /**
   * The walk-in is linked first (found or made by phone: safe to repeat), the customer's in-store orders are read (so a
   * lost answer is never matched to one of them), then the sale is created once. Nothing in here throws from inside the
   * owned request: its body is built before it is sent.
   */
  async function create() {
    if (!customer || uploading) return;
    setNote(null);
    try {
      await perform(async () => {
        const customerId = customer.kind === 'existing' ? customer.id : (await sale.linkWalkIn(walkIn)).userId;
        const body: SaleBody = { customerId, items: lines.map((l) => ({ medicineId: l.medicineId, orderedQty: qtyOf(l) })),
          isWalkIn: customer.kind === 'walkin', prescriptionUrls: prescriptions };
        const request = saleRequestBody(body);
        const before = (await sale.recentFor(customerId)).items.map((o) => o._id);
        const p = startOp<PendingSale>(newRequestKey(), { ...body, before });
        const r = await send(p, () => sale.create(request));
        if (r.kind === 'ok') {
          await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
          done(r.value.order._id);
          return;
        }
        // 503 PRESCRIPTION_CHECKOUT_UNAVAILABLE is decided before anything is written (the prescription gate runs first).
        if (r.kind === 'unknown' && codeOf(r.error) === 'PRESCRIPTION_CHECKOUT_UNAVAILABLE' && r.error instanceof ApiError && r.error.status === 503) {
          settle(p.requestKey); setReview(false); setNote(saleWords(r.error)); return;
        }
        if (r.kind === 'refused') { setReview(false); setNote(saleWords(r.error)); }
      });
    } catch (err) {
      // The walk-in's link, the read before, or the one-at-a-time guard refused or did not answer: no sale was sent.
      setReview(false);
      setNote(definitelyNotRecorded(err) ? saleWords(err) : t('walkIn.notConfirmed', { error: messageOf(err) }));
    }
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    const late = checks.count >= 2 && checks.lastAt - op.lastAttemptAt >= FORGET_AFTER_MS;
    return (
      <CheckPanel label={t('unconfirmed.panel')}
        onCheck={async () => {
          setChecks((c) => ({ count: c.count + 1, lastAt: Date.now() }));
          if (restored) return t('unconfirmed.lookInOrders');
          const found = saleCandidates((await sale.recentFor(op.body.customerId)).items, op.body, op.body.before);
          if (found.length === 1) { settle(op.requestKey); done(found[0]!._id); return null; }
          return found.length > 1 ? t('unconfirmed.several') : t('unconfirmed.notFound');
        }}
        forget={late ? { label: t('unconfirmed.forget'), confirmLabel: t('unconfirmed.forgetConfirm'), consequence: t('unconfirmed.forgetConsequence'),
          onForget: () => { settle(op.requestKey); setReview(false); } } : undefined}>
        <Alert tone="warn">{restored ? t('unconfirmed.restored') : t('unconfirmed.text', { error: op.error || t('unconfirmed.noAnswer') })}</Alert>
      </CheckPanel>
    );
  }

  const locked = review || busy || uploading;
  return (
    <form className="rx-form sale" noValidate onSubmit={check}>
      {note && <Alert>{note}</Alert>}
      <CustomerPicker customer={customer} walkIn={walkIn} errors={errors} disabled={locked}
        onCustomer={(c) => { setCustomer(c); setErrors({}); }} onWalkIn={setWalkIn} />
      <MedicinePicker lines={lines} error={errors.lines} disabled={locked} onLines={setLines} />
      <Prescriptions urls={prescriptions} disabled={review || busy} uploading={uploading} onUploading={setUploading} onUrls={setPrescriptions} />

      <section className="ws-section" aria-labelledby="sale-total-h">
        <h2 id="sale-total-h" className="j-sr-only">{t('total.title')}</h2>
        <p><strong>{t('total.estimate', { amount: formatRupees(estimate) })}</strong></p>
        <p className="ws-muted">{unpriced ? t('total.unpriced') : t('total.taxNote')}</p>
        {review ? (
          <div className="confirm" role="group" aria-label={t('review.title')}>
            <p>{t('review.text', { customer: shownCustomer, count: lines.length, amount: formatRupees(estimate) })}</p>
            {customer?.kind === 'walkin' && <p className="ws-muted">{t('review.walkIn')}</p>}
            <div className="confirm-actions">
              <Button busy={busy} onClick={() => void create()}>{t('review.create')}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setReview(false)}>{shared('action.back')}</Button>
            </div>
          </div>
        ) : <div><Button type="submit" disabled={uploading}>{t('create')}</Button></div>}
      </section>
    </form>
  );
}

function CustomerPicker({ customer, walkIn, errors, disabled, onCustomer, onWalkIn }: {
  customer: Customer | null; walkIn: { name: string; phone: string; consent: boolean }; errors: Errors; disabled: boolean;
  onCustomer: (c: Customer | null) => void; onWalkIn: (w: { name: string; phone: string; consent: boolean }) => void;
}) {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['pharmacy-sale', 'customers', search], queryFn: () => pharmacySaleApi(api).customers(search ?? ''), enabled: search !== null });
  const rows = usableCustomers(q.data?.items ?? []);
  const label = (c: (typeof rows)[number]) => [c.userId.name ?? c.typedName ?? t('customer.unnamed'), c.userId.phone].filter(Boolean).join(' · ');
  const mode = customer?.kind === 'walkin' ? 'walkin' : 'existing';
  return (
    <section className="ws-section" aria-labelledby="sale-customer-h">
      <h2 id="sale-customer-h">{t('customer.title')}</h2>
      <fieldset className="ws-checks" disabled={disabled}>
        <legend className="j-sr-only">{t('customer.title')}</legend>
        <label className="ws-check"><input type="radio" name="sale-customer" checked={mode === 'existing'} onChange={() => onCustomer(null)} /> {t('customer.existing')}</label>
        <label className="ws-check"><input type="radio" name="sale-customer" checked={mode === 'walkin'} onChange={() => onCustomer({ kind: 'walkin' })} /> {t('customer.walkIn')}</label>
      </fieldset>
      {errors.customer && <Alert>{errors.customer}</Alert>}
      {mode === 'walkin' ? (
        <div className="rx-form-row">
          <TextField label={t('walkIn.name')} value={walkIn.name} maxLength={MAX_CUSTOMER_NAME} autoComplete="off" disabled={disabled} error={errors.name}
            onChange={(e) => onWalkIn({ ...walkIn, name: e.target.value })} />
          <TextField label={t('walkIn.phone')} value={walkIn.phone} inputMode="numeric" maxLength={10} autoComplete="off" disabled={disabled} error={errors.phone}
            onChange={(e) => onWalkIn({ ...walkIn, phone: e.target.value })} />
          <label className="ws-check">
            <input type="checkbox" checked={walkIn.consent} disabled={disabled} onChange={(e) => onWalkIn({ ...walkIn, consent: e.target.checked })} /> {t('walkIn.consent')}
          </label>
          {errors.consent && <Alert>{errors.consent}</Alert>}
        </div>
      ) : customer?.kind === 'existing' ? (
        <p>{t('customer.chosen', { customer: customer.label })}{' '}
          <Button variant="ghost" disabled={disabled} onClick={() => onCustomer(null)}>{shared('action.change')}</Button></p>
      ) : (
        <>
          <div className="ws-search" role="search">
            <TextField label={t('customer.search')} value={text} maxLength={MAX_SALE_SEARCH} autoComplete="off" hint={t('customer.searchHint')}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setSearch(text.trim()); } }} />
            <Button variant="secondary" onClick={() => setSearch(text.trim())}>{shared('action.search')}</Button>
          </div>
          {search !== null && (!q.data ? (q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} /> : <Loading />)
            : rows.length === 0 ? <Empty title={t('customer.none')}>{t('customer.noneText')}</Empty>
            : (
              <ul className="ws-list sale-choices" aria-label={t('customer.results')}>
                {rows.map((c) => (
                  <li key={c._id}>
                    <Button variant="secondary" onClick={() => onCustomer({ kind: 'existing', id: c.userId._id, label: label(c) })}>
                      {t('customer.choose', { customer: label(c) })}
                    </Button>
                  </li>
                ))}
              </ul>
            ))}
        </>
      )}
    </section>
  );
}

function MedicinePicker({ lines, error, disabled, onLines }: { lines: Line[]; error?: string; disabled: boolean; onLines: (l: Line[]) => void }) {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['pharmacy-sale', 'stock', search], queryFn: () => inventoryApi(api).list({ search: search || undefined, isActive: true, limit: 20 }),
    enabled: search !== null });
  const idOfItem = (i: InventoryItem) => (typeof i.medicineId === 'object' ? i.medicineId._id : i.medicineId);
  const add = (i: InventoryItem) => {
    const id = idOfItem(i);
    if (lines.some((l) => l.medicineId === id)) return;
    onLines([...lines, { medicineId: id, name: medicineName(i.medicineId), qty: '1', max: sellableQty(i), price: typeof i.retailPrice === 'number' ? i.retailPrice : null }]);
  };
  const sellable = (q.data?.items ?? []).filter((i) => i.isActive !== false && sellableQty(i) > 0);
  return (
    <section className="ws-section" aria-labelledby="sale-lines-h">
      <h2 id="sale-lines-h">{t('lines.title')}</h2>
      {lines.length > 0 && (
        <div className="ws-table-wrap">
          <table className="j-table">
            <caption className="j-sr-only">{t('lines.caption')}</caption>
            <thead><tr><th scope={'col'}>{t('lines.medicine')}</th><th scope={'col'}>{t('lines.qty')}</th><th scope={'col'}>{t('lines.price')}</th>
              <th scope={'col'}><span className="j-sr-only">{t('lines.remove')}</span></th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.medicineId}>
                  <td>{l.name}<div className="ws-muted">{t('lines.inStock', { count: l.max })}</div></td>
                  <td>
                    <TextField label={t('lines.qtyOf', { medicine: l.name })} inputMode="numeric" value={l.qty} disabled={disabled} autoComplete="off"
                      onChange={(e) => onLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                  </td>
                  <td>{l.price === null ? t('lines.noPrice') : formatRupees(l.price)}</td>
                  <td><Button variant="ghost" disabled={disabled} onClick={() => onLines(lines.filter((_, j) => j !== i))}>{t('lines.removeOf', { medicine: l.name })}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {!disabled && (
        <>
          <div className="ws-search" role="search">
            <TextField label={t('lines.search')} value={text} maxLength={MAX_SALE_SEARCH} autoComplete="off"
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setSearch(text.trim()); } }} />
            <Button variant="secondary" onClick={() => setSearch(text.trim())}>{shared('action.search')}</Button>
          </div>
          {search !== null && (!q.data ? (q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} /> : <Loading />)
            : sellable.length === 0 ? <Empty title={t('lines.none')}>{t('lines.noneText')}</Empty>
            : (
              <ul className="ws-list sale-choices" aria-label={t('lines.results')}>
                {sellable.map((i) => {
                  const name = medicineName(i.medicineId);
                  return (
                    <li key={i._id}>
                      {name} · {t('lines.inStock', { count: sellableQty(i) })}{typeof i.retailPrice === 'number' ? ` · ${formatRupees(i.retailPrice)}` : ''}{' '}
                      <Button variant="secondary" disabled={lines.some((l) => l.medicineId === idOfItem(i))} onClick={() => add(i)}>{t('lines.add', { medicine: name })}</Button>
                    </li>
                  );
                })}
              </ul>
            ))}
        </>
      )}
    </section>
  );
}

/** The prescription files; the upload's state belongs to the sale (Create waits while one is running). */
function Prescriptions({ urls, disabled, uploading, onUploading, onUrls }: {
  urls: string[]; disabled: boolean; uploading: boolean; onUploading: (b: boolean) => void; onUrls: (u: string[]) => void;
}) {
  const { api } = useSession();
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File | undefined) {
    if (!file) return;
    onUploading(true);
    setError(null);
    try {
      const url = await pharmacySaleApi(api).uploadPrescription(file);
      if (url) onUrls([...urls, url]); else setError(t('prescription.noFile'));
    } catch (err) {
      setError(t('prescription.failed', { error: messageOf(err) }));
    } finally {
      onUploading(false);
    }
  }
  return (
    <section className="ws-section" aria-labelledby="sale-rx-h">
      <h2 id="sale-rx-h">{t('prescription.title')}</h2>
      <p className="ws-muted">{t('prescription.intro')}</p>
      {urls.length > 0 && (
        <ul className="ws-list">
          {urls.map((u, i) => (
            <li key={u}>{t('prescription.attached', { n: i + 1 })}{' '}
              <Button variant="ghost" disabled={disabled || uploading} onClick={() => onUrls(urls.filter((x) => x !== u))}>{t('prescription.remove', { n: i + 1 })}</Button></li>
          ))}
        </ul>
      )}
      {!disabled && (
        <div className="j-field">
          <label htmlFor="sale-rx-file">{t('prescription.add')}</label>
          <input id="sale-rx-file" type="file" accept="image/*,application/pdf" disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void upload(f); }} />
        </div>
      )}
      {uploading && <Loading label={t('prescription.uploading')} />}
      {error && <Alert>{error}</Alert>}
    </section>
  );
}

// ── The created sale (`/pharmacy/sale/:orderId`): its bill and the counter payment ──

export function SaleBillScreen() {
  const { orderId = '' } = useParams();
  if (!/^[0-9a-fA-F]{24}$/.test(orderId)) return <Empty title={t('done.notFound')}><Link to="/pharmacy/sale">{t('done.new')}</Link></Empty>;
  return <SaleDone key={orderId} orderId={orderId} />;
}

function SaleDone({ orderId }: { orderId: string }) {
  const { api } = useSession();
  const q = useQuery({ queryKey: ['pharmacy-orders', 'detail', orderId], queryFn: () => pharmacyOrdersApi(api).get(orderId) });
  const profile = useQuery({ queryKey: PHARMACY_PROFILE_KEY, queryFn: () => pharmacyProfileApi(api).me() });
  return (
    <>
      <PageHeading title={t('title')}>{t('done.intro')}</PageHeading>
      {!q.data ? (q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} /> : <Loading label={t('done.loading')} />)
        : (
          <>
            <Bill order={q.data} pharmacy={profile.data} />
            <Payment order={q.data} />
            <div className="ws-actions sale-noprint">
              <Button variant="secondary" onClick={() => window.print()}>{t('done.print')}</Button>
              <Link to={`/pharmacy/orders/${q.data._id}`}>{t('done.openOrder')}</Link>
              <Link to="/pharmacy/sale">{t('done.new')}</Link>
            </div>
          </>
        )}
    </>
  );
}

const PAYMENT_WORDS: Readonly<Record<string, () => string>> = { cash: () => t('payment.cash'), upi: () => t('payment.upi') };

function Bill({ order: o, pharmacy }: { order: PharmacyOrder; pharmacy?: { name?: string; address?: string; city?: string; state?: string; pincode?: string; gstNumber?: string } }) {
  const paid = o.paymentStatus === 'paid';
  const address = pharmacy ? [pharmacy.address, pharmacy.city, pharmacy.state, pharmacy.pincode].filter(Boolean).join(', ') : '';
  const how = o.paymentSource ? PAYMENT_WORDS[o.paymentSource]?.() ?? o.paymentSource : null;
  return (
    <section className="ws-section sale-bill" aria-labelledby="sale-bill-h">
      {pharmacy?.name && <p className="sale-bill-head"><strong>{pharmacy.name}</strong>{address ? <><br />{address}</> : null}
        {pharmacy.gstNumber ? <><br />{t('bill.gstin', { gstin: pharmacy.gstNumber })}</> : null}</p>}
      <h2 id="sale-bill-h">{t('bill.title', { order: orderLabel(o) })}</h2>
      <p>{formatDateTime(o.createdAt)}{o.isWalkIn ? ` · ${t('bill.walkIn')}` : ''}</p>
      <div className="ws-table-wrap">
        <table className="j-table">
          <caption className="j-sr-only">{t('bill.caption')}</caption>
          <thead><tr><th scope={'col'}>{t('lines.medicine')}</th><th scope={'col'}>{t('bill.batch')}</th><th scope={'col'}>{t('lines.qty')}</th>
            <th scope={'col'}>{t('bill.unit')}</th><th scope={'col'}>{t('bill.amount')}</th></tr></thead>
          <tbody>
            {o.items.map((it, i) => (
              <tr key={`${it.medicineId}-${i}`}>
                <td>{it.medicineName ?? it.medicineId}{it.prescriptionRequired && <> <Badge tone="warn">{t('bill.rx')}</Badge></>}</td>
                <td>{it.batchAllocations?.length
                  ? it.batchAllocations.map((b) => t('bill.batchLine', { batch: b.batchNumber, expiry: formatExpiry(b.expiryDate) })).join('; ') : '—'}</td>
                <td>{it.orderedQty}</td><td>{formatRupees(it.unitPrice)}</td><td>{formatRupees(it.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="ws-dl">
        {typeof o.discountTotal === 'number' && o.discountTotal > 0 && <><dt>{t('bill.discount')}</dt><dd>{formatRupees(o.discountTotal)}</dd></>}
        <dt>{t('bill.total')}</dt><dd><strong>{formatRupees(o.grandTotal)}</strong></dd>
        {/* Prices include GST: the tax is part of the total, never added to it. */}
        {typeof o.taxTotal === 'number' && <><dt>{t('bill.gstIncluded')}</dt><dd>{t('bill.ofWhichGst', { amount: formatRupees(o.taxTotal) })}</dd></>}
        <dt>{t('bill.payment')}</dt><dd>{paid ? (how ? t('bill.paidBy', { how }) : t('bill.paid')) : t('bill.unpaid')}</dd>
      </dl>
    </section>
  );
}

function Payment({ order: o }: { order: PharmacyOrder }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [how, setHow] = useState<CounterPayment>('cash');
  if (!canMarkPaid(o)) return null;
  async function markPaid() {
    try {
      await pharmacyOrdersApi(api).markPaid(o._id, { paymentSource: how });
    } catch (err) {
      // Already paid (an earlier answer was lost): the order read again shows it.
      if (codeOf(err) === 'ORDER_ALREADY_PAID') return;
      if (definitelyNotRecorded(err)) throw new ApiError(err instanceof ApiError ? err.status : 0, saleWords(err));
      throw new ApiError(0, t('payment.notConfirmed', { error: messageOf(err) }));
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
    }
  }
  return (
    <section className="ws-section sale-noprint" aria-labelledby="sale-pay-h">
      <h2 id="sale-pay-h">{t('payment.title')}</h2>
      {paymentWaitsForPharmacist(o) ? (
        <Alert tone="warn">{o.prescriptionStatus === 'rejected' ? t('payment.rejected') : t('payment.waitsForPharmacist')}{' '}
          {o.prescriptionStatus !== 'rejected' && <Link to={`/pharmacy/prescriptions/${o._id}?from=sale`}>{t('payment.review')}</Link>}</Alert>
      ) : (
        <>
          <fieldset className="ws-checks">
            <legend>{t('payment.how')}</legend>
            {COUNTER_PAYMENTS.map((p) => (
              <label key={p} className="ws-check"><input type="radio" name="sale-pay" checked={how === p} onChange={() => setHow(p)} /> {t(`payment.${p}`)}</label>
            ))}
          </fieldset>
          <ConfirmAction label={t('payment.markPaid')} confirmLabel={t('payment.confirm')}
            consequence={t('payment.consequence', { amount: formatRupees(o.grandTotal), how: t(`payment.${how}`) })} onConfirm={() => markPaid()} />
        </>
      )}
    </section>
  );
}

