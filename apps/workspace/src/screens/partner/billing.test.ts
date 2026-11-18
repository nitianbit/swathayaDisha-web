import type { CatalogueItem, Invoice, InvoiceEvent } from '@jansetu/api';
import { money } from './billing.tsx';
import { rebase } from '../../draft.ts';
import { draftOf, itemBody } from './CatalogueScreen.tsx';
import { mergeDetail, paymentOutcome, paymentRefusedForGood, paymentText } from './InvoiceScreen.tsx';
import { takeHandover } from './billing.tsx';
import { ApiError } from '@jansetu/api';
import { billFilter } from './InvoicesScreen.tsx';
import { buildInvoice, type InvoiceDraft } from './NewInvoiceScreen.tsx';

const inv = (version: number, state: Invoice['lifecycleState']) => ({ _id: 'e1'.repeat(12), lifecycleVersion: version, lifecycleState: state }) as Invoice;
const ev = (version: number, kind: InvoiceEvent['kind']) => ({ _id: `ev${version}`, version, kind }) as InvoiceEvent;

describe('bill page: answers never go back in time', () => {
  it('a late payment answer after the cancellation keeps the cancelled bill and both events', () => {
    const afterCancel = mergeDetail({ invoice: inv(0, 'issued'), events: [] }, { invoice: inv(2, 'cancelled'), event: ev(2, 'cancellation') });
    const late = mergeDetail(afterCancel, { invoice: inv(1, 'paid'), event: ev(1, 'payment') });
    expect(late.invoice.lifecycleState).toBe('cancelled');
    expect(late.events.map((e) => e.version)).toEqual([1, 2]);
  });

  it('in the other order the cancellation follows the payment and nothing is dropped', () => {
    const paid = mergeDetail({ invoice: inv(0, 'issued'), events: [] }, { invoice: inv(1, 'paid'), event: ev(1, 'payment') });
    const cancelled = mergeDetail(paid, { invoice: inv(2, 'cancelled'), event: ev(2, 'cancellation') });
    expect(cancelled.invoice.lifecycleVersion).toBe(2);
    expect(cancelled.events.map((e) => e.kind)).toEqual(['payment', 'cancellation']);
    // A repeated answer for the same version replaces, never duplicates.
    expect(mergeDetail(cancelled, { invoice: inv(1, 'paid'), event: ev(1, 'payment') }).events).toHaveLength(2);
  });
});

describe('an unconfirmed payment is settled only by the bill (Q14: its key and the version it named)', () => {
  const K = 'p'.repeat(32);
  const op = (expectedLifecycleVersion: number) => ({ requestKey: K, body: { splits: [{ mode: 'upi' as const, amountMinor: 100 }], requestKey: K, expectedLifecycleVersion } });
  const pay = (version: number, o: Partial<InvoiceEvent> = {}) => ({ ...ev(version, 'payment'), ...o } as InvoiceEvent);
  it('its own receipt settles it as recorded; a bill moved past its version or cancelled as never recorded; otherwise open', () => {
    expect(paymentOutcome({ invoice: inv(1, 'paid'), events: [pay(1, { requestKey: K })] }, op(0))).toBe('recorded');
    // Part payments: an earlier payment of someone else does not decide it while the bill is still at the version it named.
    expect(paymentOutcome({ invoice: inv(1, 'partly_paid'), events: [pay(1, { requestKey: 'x'.repeat(32) })] }, op(1))).toBe('unknown');
    expect(paymentOutcome({ invoice: inv(1, 'paid'), events: [pay(1, { mode: 'cash', amountMinor: 100800 })] }, op(0)))
      .toEqual({ refused: 'another payment was recorded first (Paid by Cash · ₹1,008.00).' });
    expect(paymentOutcome({ invoice: inv(1, 'cancelled'), events: [ev(1, 'cancellation')] }, op(0))).toEqual({ refused: 'the bill was cancelled.' });
    expect(paymentOutcome({ invoice: inv(0, 'issued'), events: [] }, op(0))).toBe('unknown');
    // Restored after a reload (no body): only its receipt or a cancellation decide it.
    expect(paymentOutcome({ invoice: inv(1, 'partly_paid'), events: [pay(1)] }, { requestKey: K, body: undefined as never, restored: true })).toBe('unknown');
    expect(paymentOutcome({ invoice: inv(2, 'paid'), events: [pay(1), pay(2, { requestKey: K })] }, { requestKey: K, body: undefined as never, restored: true })).toBe('recorded');
  });

  it('words a payment by its methods and amounts', () => {
    expect(paymentText({ mode: 'upi', reference: 'UTR1', amountMinor: 100800 })).toBe('Paid by UPI · reference UTR1 · ₹1,008.00');
    expect(paymentText({ splits: [{ mode: 'cash', amountMinor: 50000 }, { mode: 'upi', amountMinor: 50800, reference: 'U9' }], amountMinor: 100800 }))
      .toBe('Paid by Cash ₹500.00 + UPI ₹508.00 (reference U9) · ₹1,008.00 in all');
    expect(paymentText({ mode: 'cash' })).toBe('Paid by Cash');
  });
});

describe('bills list filters', () => {
  it('sends the Q10 filters and refuses dates in the wrong order', () => {
    expect(billFilter({ state: 'paid', branchId: '', from: '2026-11-01', to: '2026-11-15', q: '  Asha ' }).query)
      .toEqual({ state: 'paid', branchId: undefined, from: '2026-11-01', to: '2026-11-15', q: 'Asha', limit: 50 });
    expect(billFilter({ state: '', branchId: '', from: '2026-11-15', to: '2026-11-01', q: '' }).error).toBe('The “from” date is after the “to” date.');
    expect(money(100800)).toBe('₹1,008.00');
    expect(money(5)).toBe('₹0.05');
  });
});

describe('catalogue form', () => {
  const item: CatalogueItem = {
    _id: 'd1'.repeat(12), partnerId: 'a1'.repeat(12), kind: 'test', name: 'CBC', code: 'CBC01', priceMinor: 45000, mrpMinor: 50000, gstRate: 18,
    visitModes: ['lab'], isActive: true, adminDisabled: false,
  };
  const ALL_RATES = [0, 5, 12, 18, 28] as const;
  const edit = (o: Partial<ReturnType<typeof draftOf>>, base = draftOf(item)) => ({ base, draft: { ...base, ...o } });

  it('sends only the fields the person changed, in paise; a field that is set cannot be emptied', () => {
    expect(itemBody(edit({ price: '450.5' }), ALL_RATES, 'lab', true)).toEqual({ body: { priceMinor: 45050 }, errors: {} });
    expect(itemBody(edit({ code: '' }), ALL_RATES, 'lab', true).errors.code).toBe('This cannot be removed here. Enter a new value.');
    expect(itemBody(edit({ mrp: '400' }), ALL_RATES, 'lab', true).errors.mrp).toBe('MRP cannot be below the price.');
    expect(itemBody(edit({ price: '600' }), ALL_RATES, 'lab', true).errors.price).toBe('The price cannot be above the MRP. Change the MRP too.');
  });

  it('after a rebase, a field changed by someone else is not sent back', () => {
    const started = edit({ name: 'CBC count' });
    const { next, conflicts } = rebase(started, draftOf({ ...item, priceMinor: 47000 }));
    expect(conflicts).toEqual([]);
    expect(itemBody(next, ALL_RATES, 'lab', true).body).toEqual({ name: 'CBC count' });
  });

  it('a supplier without GST keeps an old rate as it is but cannot choose a new one', () => {
    expect(itemBody(edit({ name: 'CBC count' }), [0], 'lab', true)).toEqual({ body: { name: 'CBC count' }, errors: {} });
    expect(itemBody(edit({ gstRate: '5' }), [0], 'lab', true).errors.gstRate).toBe('Choose one of the GST rates offered.');
    const fresh = draftOf();
    expect(itemBody({ base: fresh, draft: { ...fresh, name: 'X', price: '1', gstRate: '5' } }, [0], 'lab', false).errors.gstRate)
      .toBe('Choose one of the GST rates offered.');
  });

  it('clinics list consultations, procedures, packages and other items, with no visit modes', () => {
    const fresh = draftOf(undefined, 'clinic');
    expect(fresh).toMatchObject({ kind: 'consultation', visitModes: [] });
    expect(itemBody({ base: fresh, draft: { ...fresh, name: 'Consultation', price: '500' } }, [0], 'clinic', false))
      .toEqual({ body: { kind: 'consultation', name: 'Consultation', priceMinor: 50000, gstRate: 0 }, errors: {} });
    expect(itemBody({ base: fresh, draft: { ...fresh, kind: 'test', name: 'X', price: '1' } }, [0], 'clinic', false).errors.kind)
      .toBe('Choose one of the types offered.');
  });
});

describe('new bill', () => {
  const branch = { address: { line1: '1 Main Rd', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560038' } };
  const base: InvoiceDraft = {
    branchId: 'c1'.repeat(12), name: ' Asha ', phone: '98765 00000', age: '', gender: '', gstin: '29abcde1234f1z5', placeOfSupply: '',
    doctorId: '', lines: [{ key: 'l1', description: 'Visit', sac: '', qty: '3', price: '99.99', discount: '0.97', gstRate: '18' }],
  };

  it('builds the request in paise with the customer as the server validates it', () => {
    const r = buildInvoice(base, { taxRegime: 'regular', gstin: '29ABCDE1234F1Z5' }, branch);
    expect(r.errors).toEqual({});
    expect(r.body).toEqual({
      branchId: 'c1'.repeat(12),
      customer: { name: 'Asha', phone: '9876500000', gstin: '29ABCDE1234F1Z5' },
      items: [{ description: 'Visit', qty: 3, unitPriceMinor: 9999, discountMinor: 97, gstRate: 18 }],
    });
    expect(r.preview.totals.totalMinor).toBe(29900 + 5382);
  });

  it('refuses what the server would refuse before anything is sent', () => {
    const r = buildInvoice({ ...base, phone: '12345', age: '200', placeOfSupply: '2', lines: [{ ...base.lines[0]!, qty: '0', discount: '500' }] },
      { taxRegime: 'unregistered' }, branch);
    expect(r.errors).toMatchObject({
      phone: 'Enter a 10-digit mobile number.', age: 'Enter the age in whole years (0 to 150).',
      placeOfSupply: 'Enter the two-digit GST state code, like 29.', 'l1.qty': 'Enter a whole number from 1 to 10000.',
      'l1.gstRate': 'Choose one of the GST rates offered.',
    });
    expect(buildInvoice({ ...base, lines: [] }, { taxRegime: 'regular', gstin: '29ABCDE1234F1Z5' }, branch).errors.lines).toBe('Add at least one item.');
    expect(buildInvoice(base, { taxRegime: 'regular', gstin: '29ABCDE1234F1Z5' }, { address: { ...branch.address, stateCode: '' } }).errors.branchId)
      .toBe('Set the branch GST state code before billing (Branches).');
  });
});

describe('WQ8 review: a keyed payment refused for good on any attempt; a bill handover bound to its navigation', () => {
  it('settles definite refusals; version/state conflicts, network losses and other 5xx stay unknown', () => {
    for (const [status, code] of [[503, 'INVOICE_INDEXES_OUTDATED'], [409, 'PART_PAYMENTS_NOT_ALLOWED'], [409, 'AMOUNT_EXCEEDS_DUE'],
      [400, 'PAYMENT_METHOD_REQUIRED'], [400, 'VALIDATION_ERROR'], [403, 'PARTNER_PERMISSION_REQUIRED']] as const) {
      expect(paymentRefusedForGood(new ApiError(status, 'x', code))).toBe(true);
    }
    for (const [status, code] of [[409, 'LIFECYCLE_VERSION_CONFLICT'], [409, 'INVOICE_STATE_CONFLICT'], [409, 'ALREADY_CANCELLED'], [503, 'UNAVAILABLE'], [0, undefined]] as const) {
      expect(paymentRefusedForGood(new ApiError(status, 'x', code))).toBe(false);
    }
    expect(paymentRefusedForGood(new Error('offline'))).toBe(false);
  });

  it('a prefill is taken only by the navigation whose route state names its token', () => {
    const prefill = { appointmentId: 'a', branchId: 'b', doctorId: 'd', name: 'Asha', phone: '9800000001', label: 'x' };
    expect(takeHandover({ token: 't1', prefill }, { prefillToken: 't1' })).toEqual(prefill);
    expect(takeHandover({ token: 't1', prefill }, null)).toBeUndefined();
    expect(takeHandover({ token: 't1', prefill }, { prefillToken: 't2' })).toBeUndefined();
    expect(takeHandover(undefined, { prefillToken: 't1' })).toBeUndefined();
  });
});
