import { createApiClient } from './client.ts';
import {
  allowedGstRates, catalogueAdminApi, classifyDocument, dueOf, invoicePdfName, MAX_BILL_MINOR, paidOf, paiseToInput, paiseToRupees,
  partnerBillingApi, paymentProblem, previewInvoice, registrationProblem, rupeesToPaise, takesPayment, type Invoice, type NewInvoiceLine,
} from './partnerInvoices.ts';

const P = 'a1'.repeat(12);
const I = 'd4'.repeat(12);
const C = 'e5'.repeat(12);

function recorder(answer: () => Response = () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: () => 'tok',
    fetchImpl: async (u, init) => {
      calls.push({ method: String(init?.method), url: String(u).replace('https://api.example.test/api/v1', ''),
        body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
      return answer();
    } });
  return { client, calls };
}

describe('rupees and paise', () => {
  it('reads rupees typed by a person as integer paise, without floating-point error', () => {
    expect(rupeesToPaise('12.05')).toBe(1205);
    expect(rupeesToPaise('0.1')).toBe(10);
    expect(rupeesToPaise('0.29')).toBe(29); // 0.29 * 100 = 28.999999999999996 in floating point
    expect(rupeesToPaise('1,23,456.7')).toBe(12345670);
    expect(rupeesToPaise(' 450 ')).toBe(45000);
    expect(rupeesToPaise('0')).toBe(0);
    expect(rupeesToPaise('100000000')).toBe(100_000_000_00);
    for (const bad of ['', '.5', '1.005', '-1', '1e3', '12.', 'abc', '₹10', '1 000']) expect(rupeesToPaise(bad)).toBeNull();
  });

  it('puts paise back into a rupee field and shows them as rupees', () => {
    expect(paiseToInput(1205)).toBe('12.05');
    expect(paiseToInput(1200)).toBe('12');
    expect(paiseToInput(7)).toBe('0.07');
    expect(paiseToInput(undefined)).toBe('');
    expect(paiseToRupees(123456)).toBe(1234.56);
    for (const p of [0, 1, 29, 1205, 99_999, 100_000_000_00]) expect(rupeesToPaise(paiseToInput(p))).toBe(p);
  });
});

describe('tax rules mirrored from services/invoice.ts', () => {
  const regular = { taxRegime: 'regular' as const, gstin: '29ABCDE1234F1Z5' };
  const line = (o: Partial<NewInvoiceLine>): NewInvoiceLine => ({ description: 'CBC', qty: 1, unitPriceMinor: 10000, gstRate: 0, ...o });

  it('classifies the document from the regime, the GSTIN and the line rates', () => {
    expect(classifyDocument(regular, [{ gstRate: 18 }, { gstRate: 0 }])).toBe('tax_invoice');
    expect(classifyDocument(regular, [{ gstRate: 0 }])).toBe('bill_of_supply');
    expect(classifyDocument({ taxRegime: 'composition', gstin: regular.gstin }, [{ gstRate: 5 }])).toBe('bill_of_supply');
    expect(classifyDocument({ taxRegime: 'regular' }, [{ gstRate: 18 }])).toBe('commercial_invoice'); // no GSTIN
    expect(classifyDocument({ taxRegime: 'unregistered' }, [{ gstRate: 0 }])).toBe('commercial_invoice');
    expect(allowedGstRates(regular)).toEqual([0, 5, 12, 18, 28]);
    expect(allowedGstRates({ taxRegime: 'composition', gstin: regular.gstin })).toEqual([0]);
    expect(allowedGstRates({ taxRegime: 'unregistered' })).toEqual([0]);
  });

  it('rounds tax per line to the paisa and sums rounded lines; Q16a: CGST and SGST are each half the rate, rounded on their own', () => {
    // 333 paise at 5% = 16.65 → 17 on the line, but CGST = SGST = 8.325 → 8; 3 × ₹99.99 − ₹0.97 = 29900 at 18% = 5382
    // (2691 + 2691); 101 at 12% = 12.12 → 12 (6.06 → 6 each).
    const p = previewInvoice(regular, '29', undefined, [
      line({ unitPriceMinor: 333, gstRate: 5 }),
      line({ qty: 3, unitPriceMinor: 9999, discountMinor: 97, gstRate: 18 }),
      line({ unitPriceMinor: 101, gstRate: 12 }),
    ]);
    expect(p.documentKind).toBe('tax_invoice');
    expect(p.sameState).toBe(true);
    expect(p.lines.map((l) => [l.amountMinor, l.taxMinor])).toEqual([[333, 17], [29900, 5382], [101, 12]]);
    // WQ11d: each line also carries the half charged (CGST = SGST), as the totals add it up.
    expect(p.lines.map((l) => l.halfMinor)).toEqual([8, 2691, 6]);
    expect(p.totals).toEqual({
      subtotalMinor: 333 + 29997 + 101, discountMinor: 97, taxableMinor: 30334,
      cgstMinor: 8 + 2691 + 6, sgstMinor: 8 + 2691 + 6, igstMinor: 0, totalMinor: 30334 + 16 + 5382 + 12, currency: 'INR',
    });
    expect(p.problems).toEqual([]);
  });

  it('half-paisa tax rounds up as the server rounds (Math.round)', () => {
    // 50 paise at 5% = 2.5 → 3; 10 paise at 5% = 0.5 → 1
    expect(previewInvoice(regular, '29', '29', [line({ unitPriceMinor: 50, gstRate: 5 }), line({ unitPriceMinor: 10, gstRate: 5 })]).lines
      .map((l) => l.taxMinor)).toEqual([3, 1]);
  });

  it('another customer state is inter-state: IGST only', () => {
    const p = previewInvoice(regular, '29', '27', [line({ unitPriceMinor: 333, gstRate: 5 })]);
    expect(p.sameState).toBe(false);
    expect(p.totals).toMatchObject({ cgstMinor: 0, sgstMinor: 0, igstMinor: 17, totalMinor: 350 });
    expect(p.lines[0]!.halfMinor).toBeUndefined();
  });

  it('flags what the server refuses: GST for a supplier without GST, discounts above the line, oversized bills, another state', () => {
    const unregistered = previewInvoice({ taxRegime: 'unregistered' }, '29', undefined, [line({ gstRate: 18 })]);
    expect(unregistered.documentKind).toBe('commercial_invoice');
    expect(unregistered.lines[0]!.problem).toBe('This partner is not GST-registered: every line must have GST rate 0');
    expect(previewInvoice({ taxRegime: 'composition', gstin: regular.gstin }, '29', undefined, [line({ gstRate: 5 })]).problems)
      .toEqual(['A bill of supply cannot charge GST: every line must have GST rate 0']);
    const discount = previewInvoice(regular, '29', undefined, [line({ qty: 2, unitPriceMinor: 100, discountMinor: 201 })]);
    expect(discount.lines[0]).toMatchObject({ amountMinor: 0, problem: 'A line discount cannot exceed the line amount' });
    expect(discount.totals.totalMinor).toBe(0);
    expect(previewInvoice(regular, '29', undefined, [line({ qty: 10_000, unitPriceMinor: MAX_BILL_MINOR })]).problems)
      .toContain('This line is larger than a single bill can be');
    expect(previewInvoice(regular, '27', undefined, [line({ gstRate: 18 })]).problems[0]).toMatch(/registration \(state 29\) does not cover this branch \(state 27\)/);
    expect(registrationProblem('commercial_invoice', undefined, '27')).toBeNull();
  });
});

describe('billing paths', () => {
  it('members use /partner-workspace; admins the same routes under the admin workspace; admin item switches by id', async () => {
    const { client, calls } = recorder();
    const member = partnerBillingApi(client, { kind: 'member' });
    const admin = partnerBillingApi(client, { kind: 'admin', partnerId: P });
    await member.catalogue('test');
    await admin.catalogue();
    await member.updateCatalogueItem(C, { priceMinor: 45000 });
    await admin.deactivateCatalogueItem(C);
    await member.invoices({ state: 'paid', branchId: P, limit: 50, cursor: `1763182800000_${I}`, from: '2026-11-01', to: '2026-11-15', q: 'Asha' });
    await admin.invoice(I);
    await admin.recordPayment(I, { splits: [{ mode: 'cash', amountMinor: 50000 }, { mode: 'upi', amountMinor: 50800, reference: 'UTR1' }], requestKey: 'p'.repeat(32), expectedLifecycleVersion: 1 });
    await member.cancelInvoice(I, 'Wrong patient', { mode: 'upi', reference: 'R1', amountMinor: 100800 });
    await admin.clinicDoctors();
    await catalogueAdminApi(client).disable(C);
    await catalogueAdminApi(client).enable(C);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /partner-workspace/catalogue?kind=test',
      `GET /partner-workspace/admin/${P}/workspace/catalogue`,
      `PUT /partner-workspace/catalogue/${C}`,
      `DELETE /partner-workspace/admin/${P}/workspace/catalogue/${C}`,
      `GET /partner-workspace/invoices?state=paid&branchId=${P}&limit=50&cursor=1763182800000_${I}&from=2026-11-01&to=2026-11-15&q=Asha`,
      `GET /partner-workspace/admin/${P}/workspace/invoices/${I}`,
      `POST /partner-workspace/admin/${P}/workspace/invoices/${I}/pay`,
      `POST /partner-workspace/invoices/${I}/cancel`,
      `GET /partner-workspace/admin/${P}/workspace/clinic/doctors`,
      `POST /partner-workspace/admin/catalogue/${C}/disable`,
      `POST /partner-workspace/admin/catalogue/${C}/enable`,
    ]);
    expect(calls[6]!.body).toEqual({ splits: [{ mode: 'cash', amountMinor: 50000 }, { mode: 'upi', amountMinor: 50800, reference: 'UTR1' }], requestKey: 'p'.repeat(32), expectedLifecycleVersion: 1 });
    expect(calls[7]!.body).toEqual({ reason: 'Wrong patient', refund: { mode: 'upi', reference: 'R1', amountMinor: 100800 } });
  });

  it('Q14: payments are split methods with a key and the version decided on; bills of one appointment; checked before sending', async () => {
    const { client, calls } = recorder();
    const api = partnerBillingApi(client, { kind: 'member' });
    await api.invoices({ appointmentId: C, limit: 50 });
    expect(calls[0]!.url).toBe(`/partner-workspace/invoices?appointmentId=${C}&limit=50`);
    const ok = { splits: [{ mode: 'cash' as const, amountMinor: 100 }], requestKey: 'p'.repeat(32), expectedLifecycleVersion: 0 };
    expect(() => api.recordPayment(I, { ...ok, requestKey: 'short' })).toThrow(/request key/);
    expect(() => api.recordPayment(I, { ...ok, expectedLifecycleVersion: -1 })).toThrow(/version/);
    expect(() => api.recordPayment(I, { ...ok, splits: [] })).toThrow(/payment/);
    expect(() => api.recordPayment(I, { ...ok, splits: [{ mode: 'cash', amountMinor: 0 }] })).toThrow(/payment/);
    expect(() => api.recordPayment(I, { ...ok, splits: [{ mode: 'gold' as never, amountMinor: 5 }] })).toThrow(/payment/);
    expect(() => api.recordPayment(I, { requestKey: 'p'.repeat(32), expectedLifecycleVersion: 0, mode: 'gold' as never })).toThrow(/payment/);
    expect(() => api.invoices({ appointmentId: '../x' })).toThrow(/appointment id/);
    expect(() => api.createInvoice({ branchId: P, customer: { name: 'A' }, items: [], idempotencyKey: 'k', appointmentId: 'x' })).toThrow(/appointment id/);
    expect(calls).toHaveLength(1);
  });
});

describe('Q14 part payments (paidOf, withDue, recordPayment)', () => {
  const bill = (o: Partial<Invoice>) => ({ lifecycleState: 'issued', totals: { totalMinor: 100800 }, ...o }) as Invoice;
  it('reads what was paid and what is due, also for bills read before Q14', () => {
    expect([paidOf(bill({})), dueOf(bill({}))]).toEqual([0, 100800]);
    expect([paidOf(bill({ lifecycleState: 'paid' })), dueOf(bill({ lifecycleState: 'paid' }))]).toEqual([100800, 0]);
    expect([paidOf(bill({ lifecycleState: 'partly_paid', paidMinor: 50000, dueMinor: 50800 })), dueOf(bill({ lifecycleState: 'partly_paid', paidMinor: 50000, dueMinor: 50800 }))]).toEqual([50000, 50800]);
    expect(dueOf(bill({ lifecycleState: 'cancelled', paidMinor: 50000 }))).toBe(0);
    expect(takesPayment(bill({}))).toBe(true);
    expect(takesPayment(bill({ lifecycleState: 'partly_paid', paidMinor: 50000, dueMinor: 50800 }))).toBe(true);
    expect(takesPayment(bill({ lifecycleState: 'paid' }))).toBe(false);
    expect(takesPayment(bill({ lifecycleState: 'cancelled' }))).toBe(false);
    // Q14 review: a ₹0 bill can still be marked paid (with a plain method).
    expect(takesPayment(bill({ totals: { totalMinor: 0 } as Invoice['totals'] }))).toBe(true);
  });

  it('never more than is due; with part payments off exactly what is due; 1–10 positive parts', () => {
    const m = (n: number) => `₹${n / 100}`;
    expect(paymentProblem([{ amountMinor: 100800 }], 100800, false, m)).toBeNull();
    expect(paymentProblem([{ amountMinor: 50000 }, { amountMinor: 50800 }], 100800, false, m)).toBeNull();
    expect(paymentProblem([{ amountMinor: 50000 }], 100800, false, m)).toBe('Only full payment is taken here: the amounts must add up to ₹1008.');
    expect(paymentProblem([{ amountMinor: 50000 }], 100800, true, m)).toBeNull();
    expect(paymentProblem([{ amountMinor: 100900 }], 100800, true, m)).toMatch(/more than is due \(₹1008\)/);
    expect(paymentProblem([{ amountMinor: null }], 100800, true, m)).toMatch(/Enter each amount/);
    expect(paymentProblem([{ amountMinor: 0 }], 100800, true, m)).toMatch(/Enter each amount/);
    expect(paymentProblem([], 100800, true, m)).toMatch(/how the bill was paid/);
    expect(paymentProblem(Array.from({ length: 11 }, () => ({ amountMinor: 1 })), 100800, true, m)).toMatch(/At most 10/);
    expect(paymentProblem([{ amountMinor: 1, reference: 'x'.repeat(201) }], 100800, true, m)).toMatch(/200 characters/);
  });

  it('Q10: inactive items, reactivate, bill lookup and abandon by key; keys checked before any path', async () => {
    const { client, calls } = recorder();
    const member = partnerBillingApi(client, { kind: 'member' });
    const admin = partnerBillingApi(client, { kind: 'admin', partnerId: P });
    await member.catalogue(undefined, true);
    await admin.reactivateCatalogueItem(C);
    await member.invoiceByKey('k'.repeat(32));
    await admin.abandonInvoiceKey('k'.repeat(32));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /partner-workspace/catalogue?includeInactive=true',
      `POST /partner-workspace/admin/${P}/workspace/catalogue/${C}/reactivate`,
      `GET /partner-workspace/invoices/by-key/${'k'.repeat(32)}`,
      `POST /partner-workspace/admin/${P}/workspace/invoices/by-key/${'k'.repeat(32)}/abandon`,
    ]);
    expect(() => member.invoiceByKey('../x')).toThrow('Invalid request key');
    expect(() => member.abandonInvoiceKey('a/b')).toThrow('Invalid request key');
    expect(calls).toHaveLength(4);
  });

  it('Q12: server search of the price list, item lookup and give-up by key; checked before any path', async () => {
    const { client, calls } = recorder();
    const member = partnerBillingApi(client, { kind: 'member' });
    const admin = partnerBillingApi(client, { kind: 'admin', partnerId: P });
    await member.catalogue(undefined, true, '  cbc & co ');
    await member.catalogue(undefined, false, '   ');
    await member.catalogueItemByKey('k'.repeat(32));
    await admin.abandonCatalogueKey('k'.repeat(32));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /partner-workspace/catalogue?includeInactive=true&q=cbc+%26+co',
      'GET /partner-workspace/catalogue',
      `GET /partner-workspace/catalogue/by-key/${'k'.repeat(32)}`,
      `POST /partner-workspace/admin/${P}/workspace/catalogue/by-key/${'k'.repeat(32)}/abandon`,
    ]);
    expect(() => member.catalogue(undefined, false, 'x'.repeat(61))).toThrow('Search is too long');
    expect(() => member.catalogueItemByKey('short')).toThrow('Invalid request key');
    expect(() => member.abandonCatalogueKey('a/bcdefghij')).toThrow('Invalid request key');
    expect(calls).toHaveLength(4);
  });

  it('a bills page carries the total and the next cursor', async () => {
    const { client } = recorder(() => new Response(JSON.stringify({ success: true, data: [{ _id: I }], pagination: { total: 51, nextCursor: `1_${I}` } }), { status: 200 }));
    const page = await partnerBillingApi(client, { kind: 'member' }).invoices({ limit: 1 });
    expect(page).toMatchObject({ items: [{ _id: I }], total: 51, nextCursor: `1_${I}` });
    const { client: last } = recorder(() => new Response(JSON.stringify({ success: true, data: [], pagination: { total: 0, nextCursor: null } }), { status: 200 }));
    expect((await partnerBillingApi(last, { kind: 'member' }).invoices()).nextCursor).toBeNull();
  });

  it('the invoice request key travels in the body exactly as sent (no header), so a resend is identical', async () => {
    const { client, calls } = recorder(() => new Response(JSON.stringify({ success: true, data: { _id: I } }), { status: 201 }));
    const body = { branchId: P, customer: { name: 'Asha' }, items: [{ description: 'CBC', qty: 1, unitPriceMinor: 45000, gstRate: 0 as const }], idempotencyKey: 'k'.repeat(32) };
    await partnerBillingApi(client, { kind: 'member' }).createInvoice(body);
    await partnerBillingApi(client, { kind: 'member' }).createInvoice(body);
    expect(calls.map((c) => c.url)).toEqual(['/partner-workspace/invoices', '/partner-workspace/invoices']);
    expect(calls[0]!.body).toEqual(body);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(calls[0]!.headers['Idempotency-Key']).toBeUndefined();
  });

  it('reads the PDF as a blob with the token in the header, never in the URL', async () => {
    const { client, calls } = recorder(() => new Response('%PDF-1.4', { status: 200, headers: { 'Content-Type': 'application/pdf' } }));
    const blob = await partnerBillingApi(client, { kind: 'admin', partnerId: P }).invoicePdf(I, 0);
    expect(await blob.text()).toBe('%PDF-1.4');
    expect(calls[0]!.url).toBe(`/partner-workspace/admin/${P}/workspace/invoices/${I}/pdf?version=0`);
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok');
    expect(invoicePdfName('CL/2627/0001', 1)).toBe('CL-2627-0001-v1.pdf');
  });

  it('refuses an id that is not an object id before any request', () => {
    const { client, calls } = recorder();
    const member = partnerBillingApi(client, { kind: 'member' });
    expect(() => member.invoice('../me')).toThrow('Invalid invoice id');
    expect(() => member.invoicePdf(`${I}/x`)).toThrow('Invalid invoice id');
    expect(() => member.catalogueItem('abc')).toThrow('Invalid catalogue item id');
    expect(() => partnerBillingApi(client, { kind: 'admin', partnerId: 'x' }).invoices()).toThrow('Invalid partner id');
    expect(() => catalogueAdminApi(client).disable('1'.repeat(25))).toThrow('Invalid catalogue item id');
    expect(calls).toHaveLength(0);
  });
});
