import './sale.css';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
  ApiError, formatExpiry, inventoryApi, isRxMedicine, MAX_CUSTOMER_NAME, MAX_SALE_SEARCH, medicineName, OBJECT_ID_PATTERN, pharmacyOrdersApi,
  pharmacySaleApi, saleRequestBody, sellableQty, usableCustomers, walkInProblems,
  type CounterPayment, type InventoryItem, type PharmacyOrder, type SaleBody,
} from '@jansetu/api';
import { formatRupees } from '@jansetu/i18n';
import { Alert, Badge, Button, Empty, ErrorState, formatDateTime, Loading, shared, TextField } from '@jansetu/ui';
import { ConfirmAction } from '../../components/ConfirmAction.tsx';
import { messageOf } from '../../errors.ts';
import { t } from '../../i18n/sale/index.ts';
import { PageHeading } from '../../PageHeading.tsx';
import { definitelyNotRecorded, newRequestKey, startOp, type PendingOp } from '../../requests.ts';
import { useSession } from '../../session.tsx';
import { useOneAtATime } from '../finance/finance.tsx';
import { canMarkPaid, ORDER_STATUS_LABEL, orderLabel, paymentWaitsForPharmacist } from './orderLabels.ts';
import { CheckPanel, useKeyedCheck, useOwnedOp, usePharmacyId } from './ownedOp.tsx';
import { useVisitMode, useVisitPreset, type VisitPatient } from './visitPatient.ts';
import { methodWords, PaymentMethodPicker, paymentWords } from './paymentPicker.tsx';
import { VisitPatientLine, visitWho } from './visitBar.tsx';

/**
 * WQ50: Pharmacy › New sale, one screen for a counter sale: the customer (one this pharmacy already has, or a walk-in by
 * name and phone, linked with the patient's agreement), medicines from active stock, an optional prescription, then the
 * one primary action, "Create sale" (an owned request with its key, r36: a lost answer is sent again unchanged under the
 * same key, checked by the key, or given up by the key: one sale per key, whatever happens). WQ50b: the created
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
interface Line { medicineId: string; name: string; qty: string; max: number; price: number | null; rx: boolean }
type Errors = Partial<Record<'customer' | 'name' | 'phone' | 'consent' | 'lines', string>>;

const codeOf = (err: unknown) => (err instanceof ApiError ? err.code ?? null : null);
/** The server's refusals of a sale this page words (pharmacyOrders, pharmacyCustomers, the pharmacy guard). */
const REFUSALS = ['INSUFFICIENT_BATCH_STOCK', 'INSUFFICIENT_STOCK', 'MEDICINE_NOT_AVAILABLE', 'PRICE_NOT_AVAILABLE', 'DUPLICATE_ORDER_MEDICINE',
  'CUSTOMER_NOT_LINKED', 'USER_NOT_FOUND', 'CONSENT_REQUIRED', 'FORBIDDEN', 'PRESCRIPTION_CHECKOUT_UNAVAILABLE', 'PRESCRIPTION_REVIEW_REQUIRED',
  'MARK_PAID_NOT_ALLOWED', 'ORDER_TERMINAL', 'ORDER_CANCEL_PENDING', 'ORDER_ALREADY_REFUNDED', 'INDEXES_OUTDATED', 'IDEMPOTENCY_KEY_REUSED',
  'REQUEST_ABANDONED'] as const;
/** Refused before anything was written (503: the prescription gate, or the server's indexes not built yet). */
const REFUSED_BEFORE_WRITING = ['PRESCRIPTION_CHECKOUT_UNAVAILABLE', 'INDEXES_OUTDATED'];
type Refusal = (typeof REFUSALS)[number];
/** A refusal in words (the server's code), else the server's message. */
function saleWords(err: unknown): string {
  const code = codeOf(err);
  return (REFUSALS as readonly (string | null)[]).includes(code) ? t(`refusal.${code as Refusal}`) : messageOf(err);
}
/** A sale that is no longer one (cancelled, abandoned or rejected): no bill is shown or printed. */
const CLOSED: readonly PharmacyOrder['status'][] = ['cancelled', 'abandoned', 'rejected'];
const qtyOf = (l: Line) => (/^\d{1,5}$/.test(l.qty.trim()) ? Number(l.qty.trim()) : NaN);

function SaleForm({ pharmacyId }: { pharmacyId: string }) {
  const { api } = useSession();
  const sale = pharmacySaleApi(api);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { perform, busy } = useOneAtATime('order');
  const { op, send, settle } = useOwnedOp<SaleBody>(`pharmacy-sale:${pharmacyId}`);
  // WQ54/WQ54b: opened from + New, the visit's patient is the customer: one this pharmacy has (found there), else a
  // walk-in by that phone and name (linked by phone: found or made, as for any walk-in).
  const preset = useVisitPreset(pharmacyId);
  const [customer, setCustomer] = useState<Customer | null>(() => (!preset ? null : preset.customerId
    ? { kind: 'existing', id: preset.customerId, label: visitWho(preset) } : { kind: 'walkin' }));
  // WQ54c: an order has a customer, not a patient: a family member's medicines are sold to the phone's owner.
  const [walkIn, setWalkIn] = useState(() => ({ name: (preset?.family ? preset.family.holderName : preset?.name) ?? '', phone: preset?.phone ?? '', consent: false }));
  const [lines, setLines] = useState<Line[]>([]);
  const [prescriptions, setPrescriptions] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [review, setReview] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const linesOk = lines.length > 0 && lines.every((l) => Number.isInteger(qtyOf(l)) && qtyOf(l) >= 1 && qtyOf(l) <= l.max);
  const estimate = lines.reduce((a, l) => a + (Number.isFinite(qtyOf(l)) && l.price !== null ? qtyOf(l) * l.price : 0), 0);
  const unpriced = lines.some((l) => l.price === null);
  const shownCustomer = customer?.kind === 'existing' ? customer.label : customer?.kind === 'walkin' ? `${walkIn.name.trim()} · ${walkIn.phone.trim()}` : '';
  // WQ54c: a sale opened from + New keeps the big type on its bill (only that it was a visit, no patient, is in the history).
  const done = (orderId: string) => navigate(`/pharmacy/sale/${orderId}`, { replace: true, ...(preset ? { state: { visit: true } } : {}) });
  const keyed = useKeyedCheck(settle, { byKey: sale.byKey, abandon: sale.abandon }, {
    found: async (r) => { await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] }); done(r.order._id); },
    givenUp: () => { setReview(false); setNote(t('unconfirmed.givenUp')); },
    notYet: (restored) => (restored ? t('unconfirmed.notYetRestored') : t('unconfirmed.notYet')),
    cannotGiveUp: () => setNote(t('unconfirmed.cannotGiveUp')),
    failed: (err) => setNote(saleWords(err)),
  });
  const rxLines = lines.filter((l) => l.rx);

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

  /** Sends `p` (its key and body, unchanged on a resend); one sale per key on the server. */
  async function ask(p: PendingOp<SaleBody>) {
    const sole = p.attempts === 0 && !p.uncertain;
    const r = await perform(() => send(p, (b) => sale.create(saleRequestBody(b), p.requestKey)));
    if (r.kind === 'stale') return;
    if (r.kind === 'ok') {
      await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] });
      done(r.value.order._id);
      return;
    }
    // 503s decided before anything is written: the only attempt asked for nothing.
    const code = codeOf(r.error);
    if (r.kind === 'unknown' && sole && code && REFUSED_BEFORE_WRITING.includes(code)) { settle(p.requestKey); setReview(false); setNote(saleWords(r.error)); return; }
    // r36: the key was used for another body: what it holds is read by the key (a sale made under it is shown).
    if (code === 'IDEMPOTENCY_KEY_REUSED') {
      const held = await sale.byKey(p.requestKey).catch(() => null);
      if (held?.state === 'used') { settle(p.requestKey); await queryClient.invalidateQueries({ queryKey: ['pharmacy-orders'] }); done(held.order._id); return; }
    }
    if (r.kind === 'refused') { setReview(false); setNote(saleWords(r.error)); return; }
    if (code && REFUSALS.includes(code as Refusal)) setNote(saleWords(r.error));
  }

  /**
   * The walk-in is linked first (found or made by phone: safe to repeat), then the sale is sent with a new key. Its body is
   * built (and checked) before it is sent, so nothing inside the owned request throws.
   */
  async function create() {
    if (!customer || uploading) return;
    setNote(null);
    let body: SaleBody;
    try {
      const customerId = customer.kind === 'existing' ? customer.id : (await perform(() => sale.linkWalkIn(walkIn))).userId;
      body = { customerId, items: lines.map((l) => ({ medicineId: l.medicineId, orderedQty: qtyOf(l) })), isWalkIn: customer.kind === 'walkin', prescriptionUrls: prescriptions };
      saleRequestBody(body);
    } catch (err) {
      // The walk-in's link (or the one-at-a-time guard) refused or did not answer: no sale was sent.
      setReview(false);
      setNote(definitelyNotRecorded(err) ? saleWords(err) : t('walkIn.notConfirmed', { error: messageOf(err) }));
      return;
    }
    await ask(startOp(newRequestKey(), body));
  }

  if (op && !(busy && op.attempts === 1 && !op.uncertain)) {
    const restored = !!op.restored || !op.body;
    return (
      <>
        {note && <Alert>{note}</Alert>}
        <CheckPanel label={t('unconfirmed.panel')} onCheck={() => keyed.check(op)}
          resend={restored ? undefined : { label: t('unconfirmed.resend'), busy: busy && !keyed.givingUp, onClick: () => { setNote(null); void ask(op); } }}
          giveUp={{ label: t('unconfirmed.giveUp'), busy: keyed.givingUp, onClick: () => void keyed.giveUp(op, perform) }}>
          <Alert tone="warn">{restored ? t('unconfirmed.restored') : t('unconfirmed.text', { error: op.error || t('unconfirmed.noAnswer') })}</Alert>
        </CheckPanel>
      </>
    );
  }

  const locked = review || busy || uploading;
  return (
    <form className="rx-form sale" noValidate onSubmit={check}>
      {note && <Alert>{note}</Alert>}
      {preset ? <VisitCustomer visit={preset} customer={customer} walkIn={walkIn} errors={errors} disabled={locked} onWalkIn={setWalkIn} />
        : <CustomerPicker customer={customer} walkIn={walkIn} errors={errors} disabled={locked}
          onCustomer={(c) => { setCustomer(c); setErrors({}); }} onWalkIn={setWalkIn} />}
      <MedicinePicker lines={lines} error={errors.lines} disabled={locked} onLines={setLines} />
      <Prescriptions urls={prescriptions} disabled={review || busy} uploading={uploading} onUploading={setUploading} onUrls={setPrescriptions} />

      <section className="ws-section" aria-labelledby="sale-total-h">
        <h2 id="sale-total-h" className="j-sr-only">{t('total.title')}</h2>
        <p><strong>{t('total.estimate', { amount: formatRupees(estimate) })}</strong></p>
        <p className="ws-muted">{unpriced ? t('total.unpriced') : t('total.taxNote')}</p>
        {/* r36: the stock list names prescription medicines, so the pharmacist's step is said before the sale is made. */}
        {rxLines.length > 0 && <Alert tone="warn">{t('total.rx', { medicines: rxLines.map((l) => l.name).join(', ') })}</Alert>}
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

/** WQ54b: the customer of a sale opened from + New: named once; a walk-in is asked only its name (if + New had none) and agreement. */
function VisitCustomer({ visit, customer, walkIn, errors, disabled, onWalkIn }: {
  visit: VisitPatient; customer: Customer | null; walkIn: { name: string; phone: string; consent: boolean }; errors: Errors; disabled: boolean;
  onWalkIn: (w: { name: string; phone: string; consent: boolean }) => void;
}) {
  return (
    <section className="ws-section" aria-labelledby="sale-customer-h">
      <h2 id="sale-customer-h">{t('customer.title')}</h2>
      <VisitPatientLine patient={visit} canChange={!disabled} />
      {visit.family && <p className="ws-muted">{t('visit.familySale')}</p>}
      {customer?.kind === 'walkin' && (
        <>
          {((visit.family ? !visit.family.holderName : !visit.name) || errors.name) && (
            <TextField label={t('walkIn.name')} value={walkIn.name} maxLength={MAX_CUSTOMER_NAME} autoComplete="off" disabled={disabled} error={errors.name}
              onChange={(e) => onWalkIn({ ...walkIn, name: e.target.value })} />
          )}
          {errors.phone && <Alert>{errors.phone}</Alert>}
          <label className="ws-check visit-consent">
            <input type="checkbox" checked={walkIn.consent} disabled={disabled} onChange={(e) => onWalkIn({ ...walkIn, consent: e.target.checked })} /> {t('walkIn.consent')}
          </label>
          {errors.consent && <Alert>{errors.consent}</Alert>}
        </>
      )}
    </section>
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
  const rows = usableCustomers(q.data ?? []);
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
    onLines([...lines, { medicineId: id, name: medicineName(i.medicineId), qty: '1', max: sellableQty(i), price: typeof i.retailPrice === 'number' ? i.retailPrice : null,
      rx: isRxMedicine(i.medicineId) }]);
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
                  <td>{l.name}{l.rx && <> <Badge tone="warn">{t('bill.rx')}</Badge></>}<div className="ws-muted">{t('lines.inStock', { count: l.max })}</div></td>
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
                      {name}{isRxMedicine(i.medicineId) && <> <Badge tone="warn">{t('bill.rx')}</Badge></>}
                      {' · '}{t('lines.inStock', { count: sellableQty(i) })}{typeof i.retailPrice === 'number' ? ` · ${formatRupees(i.retailPrice)}` : ''}{' '}
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
  if (!OBJECT_ID_PATTERN.test(orderId)) return <Empty title={t('done.notFound')}><Link to="/pharmacy/sale">{t('done.new')}</Link></Empty>;
  return <SaleDone key={orderId} orderId={orderId} />;
}

function SaleDone({ orderId }: { orderId: string }) {
  const { api } = useSession();
  const visit = (useLocation().state as { visit?: unknown } | null)?.visit === true;
  useVisitMode(visit);
  const q = useQuery({ queryKey: ['pharmacy-orders', 'detail', orderId], queryFn: () => pharmacyOrdersApi(api).get(orderId) });
  return (
    <>
      <PageHeading title={t('title')}>{t('done.intro')}</PageHeading>
      {!q.data ? (q.isError ? <ErrorState message={messageOf(q.error)} onRetry={() => void q.refetch()} /> : <Loading label={t('done.loading')} />)
        // A keyed replay (and this read) answers the order as it is now: a closed one has no bill to print.
        : CLOSED.includes(q.data.status) ? (
          <Alert tone="warn">{t('done.closed', { order: orderLabel(q.data), state: ORDER_STATUS_LABEL[q.data.status] ?? q.data.status })}{' '}
            <Link to={`/pharmacy/orders/${q.data._id}`}>{t('done.openOrder')}</Link></Alert>
        ) : (
          <>
            <Bill order={q.data} />
            <Payment order={q.data} />
            {visit ? (
              // WQ54c/WQ54d: one obvious next step after a visit's sale, once it is paid (until then it is Mark paid); one
              // that cannot be paid here (the pharmacist reviews it first) gets a plain Done. The rest small.
              <div className="ws-actions sale-noprint">
                {q.data.paymentStatus === 'paid' ? <Link className="j-btn j-btn--primary" to="/">{t('done.done')}</Link>
                  : !canMarkPaid(q.data) && <Link className="j-btn j-btn--secondary" to="/">{t('done.done')}</Link>}
                <Button variant="ghost" onClick={() => window.print()}>{t('done.print')}</Button>
                <Link className="ws-muted" to={`/pharmacy/orders/${q.data._id}`}>{t('done.openOrder')}</Link>
              </div>
            ) : (
              <div className="ws-actions sale-noprint">
                <Button variant="secondary" onClick={() => window.print()}>{t('done.print')}</Button>
                <Link to={`/pharmacy/orders/${q.data._id}`}>{t('done.openOrder')}</Link>
                <Link to="/pharmacy/sale">{t('done.new')}</Link>
              </div>
            )}
          </>
        )}
    </>
  );
}

/**
 * The cash memo: r36's `bill` on the pharmacy's order read (the selling pharmacy's name, address, GSTIN and drug licence;
 * once paid, how and when), the customer as this pharmacy may name them, and each line's batches with their expiry.
 */
function Bill({ order: o }: { order: PharmacyOrder }) {
  const paid = o.paymentStatus === 'paid';
  const ph = o.bill?.pharmacy ?? null;
  const address = ph ? [ph.address, ph.city, ph.state, ph.pincode].filter(Boolean).join(', ') : '';
  const method = o.bill?.paymentMethod ?? o.paymentSource ?? null;
  const how = method ? methodWords(method) : null;
  const c = typeof o.customerId === 'object' && o.customerId ? o.customerId : null;
  const customer = c ? [c.name, c.phone].filter(Boolean).join(' · ') : '';
  return (
    <section className="ws-section sale-bill" aria-labelledby="sale-bill-h">
      {ph?.name && (
        <p className="sale-bill-head"><strong>{ph.name}</strong>{address ? <><br />{address}</> : null}
          {ph.gstNumber ? <><br />{t('bill.gstin', { gstin: ph.gstNumber })}</> : null}
          {ph.drugLicenseNumber ? <><br />{t('bill.drugLicence', { number: ph.drugLicenseNumber })}</> : null}</p>
      )}
      <h2 id="sale-bill-h">{t('bill.title', { order: orderLabel(o) })}</h2>
      <p>{formatDateTime(o.createdAt)}{customer ? ` · ${customer}` : ''}{o.isWalkIn ? ` · ${t('bill.walkIn')}` : ''}</p>
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
        <dt>{t('bill.payment')}</dt>
        <dd>{paid ? (how ? t('bill.paidBy', { how }) : t('bill.paid')) : t('bill.unpaid')}{paid && o.bill?.paidAt ? ` · ${formatDateTime(o.bill.paidAt)}` : ''}</dd>
      </dl>
    </section>
  );
}

function Payment({ order: o }: { order: PharmacyOrder }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [how, setHow] = useState<CounterPayment | null>(null);
  if (!canMarkPaid(o)) return null;
  async function markPaid() {
    if (!how) return;
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
          <PaymentMethodPicker value={how} onChange={setHow} name="sale-pay" />
          <ConfirmAction label={t('payment.markPaid')} confirmLabel={t('payment.confirm')} disabled={!how}
            consequence={how ? t('payment.consequence', { amount: formatRupees(o.grandTotal), how: paymentWords(how) }) : ''} onConfirm={() => markPaid()} />
        </>
      )}
    </section>
  );
}

