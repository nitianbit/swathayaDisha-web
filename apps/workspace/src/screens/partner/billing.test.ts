import type { CatalogueItem, Invoice, InvoiceEvent } from '@jansetu/api';
import { money } from './billing.tsx';
import { rebase } from '../../draft.ts';
import { draftOf, itemBody } from './CatalogueScreen.tsx';
import { mergeDetail, paymentOutcome } from './InvoiceScreen.tsx';
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

describe('an unconfirmed payment is settled only by the bill', () => {
  const paidWith = (mode: string, reference?: string) => ({
    invoice: inv(1, 'paid'), events: [{ ...ev(1, 'payment'), mode, ...(reference ? { reference } : {}) } as InvoiceEvent],
  });
  it('its own receipt settles it as recorded; another payment or a cancellation as not recorded; an unpaid bill leaves it open', () => {
    expect(paymentOutcome(paidWith('upi', 'UTR9'), { mode: 'upi', reference: 'UTR9' })).toBe('recorded');
    expect(paymentOutcome(paidWith('cash'), { mode: 'upi', reference: 'UTR9' })).toEqual({ refused: 'another payment was recorded first (Cash).' });
    expect(paymentOutcome({ invoice: inv(1, 'cancelled'), events: [ev(1, 'cancellation')] }, { mode: 'cash' })).toEqual({ refused: 'the bill was cancelled.' });
    expect(paymentOutcome({ invoice: inv(0, 'issued'), events: [] }, { mode: 'cash' })).toBe('unknown');
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
