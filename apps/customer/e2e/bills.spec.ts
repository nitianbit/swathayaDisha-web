import { expect, test, type Page, type Route } from '@playwright/test';

const ME = 'c1'.repeat(12);
const PAID = 'b1'.repeat(12);
const UNPAID = 'b2'.repeat(12);
const DOC = 'd1'.repeat(12);

const bill = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id, partnerId: 'a1'.repeat(12), branchId: 'a2'.repeat(12), serial: 'SUN/2026-27/000123', documentKind: 'tax_invoice',
  issuedAt: '2026-11-14T05:30:00.000Z', lifecycleState: 'paid', lifecycleVersion: 1, doctorId: DOC, doctorName: 'Dr. Meena Iyer',
  supplier: { name: 'Sunrise Diagnostics', legalName: 'Sunrise Diagnostics Pvt Ltd', gstin: '27ABCDE1234F1Z5', address: '4 Paud Road, Pune', placeOfSupply: '27' },
  customer: { name: 'Asha Rao', phone: '9876543210' },
  items: [
    { description: 'Complete blood count', sac: '999316', qty: 1, unitPriceMinor: 40000, discountMinor: 0, gstRate: 18, amountMinor: 40000 },
    { description: 'Consultation', qty: 2, unitPriceMinor: 30000, discountMinor: 10000, gstRate: 18, amountMinor: 50000 },
  ],
  totals: { subtotalMinor: 100000, discountMinor: 10000, taxableMinor: 90000, cgstMinor: 8100, sgstMinor: 8100, igstMinor: 0, totalMinor: 106200, currency: 'INR' },
  ...over,
});

interface Backend { calls: { path: string; auth?: string }[]; failList: number; bills: Record<string, Record<string, unknown>> }

async function mockBackend(page: Page): Promise<Backend> {
  const state: Backend = { calls: [], failList: 0, bills: {} };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown) => json(route, 200, { success: true, data });
  const bills: Record<string, ReturnType<typeof bill>> = {
    [PAID]: bill(PAID),
    [UNPAID]: bill(UNPAID, { serial: 'CARE/2026-27/000007', lifecycleState: 'issued', lifecycleVersion: 0, doctorId: undefined, doctorName: undefined,
      supplier: { name: 'CarePlus Clinic', address: 'Indiranagar, Bengaluru', placeOfSupply: '29' },
      items: [{ description: 'Dressing', qty: 1, unitPriceMinor: 25000, discountMinor: 0, gstRate: 18, amountMinor: 25000 }],
      totals: { subtotalMinor: 25000, discountMinor: 0, taxableMinor: 25000, cgstMinor: 0, sgstMinor: 0, igstMinor: 4500, totalMinor: 29500, currency: 'INR' } }),
  };
  state.bills = bills;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    state.calls.push({ path: `${path}${url.search}`, auth: req.headers().authorization });
    if (path === '/auth/user/send') return json(route, 200, { success: true });
    if (path === '/auth/user/verify') return ok(route, { token: 't', user: {} });
    if (path === '/auth/session/refresh') return json(route, 401, { error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' });
    if (path === '/auth/profile') return ok(route, { user: { _id: ME, name: 'Asha Rao', phone: '9876543210', email: 'a@x.in', gender: 'Female', dateOfBirth: '19900101' }, userRole: 'user' });
    if (path === `/wallet/user/${ME}`) return ok(route, { _id: 'w', userId: ME, balance: 0, isActive: true });
    if (path === '/bills') {
      if (state.failList > 0) { state.failList -= 1; return json(route, 400, { error: 400, code: 'BAD', message: 'Bills could not be loaded' }); }
      const all = Object.values(bills);
      return json(route, 200, { success: true, data: all, pagination: { page: 1, limit: 20, total: all.length, totalPages: 1 } });
    }
    const m = /^\/bills\/(\w{24})(\/pdf)?$/.exec(path);
    if (m) {
      const b = bills[m[1]!];
      if (!b) return json(route, 404, { error: 404, code: 'INVOICE_NOT_FOUND', message: 'Bill not found' });
      if (m[2]) return route.fulfill({ status: 200, contentType: 'application/pdf', body: `%PDF-1.4\nbill v${url.searchParams.get('version')}` });
      const events = (b as Record<string, unknown>).events as Record<string, unknown>[] | undefined ?? [
        ...(b.lifecycleVersion >= 1 ? [{ kind: 'payment', mode: 'upi', version: 1, at: '2026-11-14T06:00:00.000Z' }] : []),
        ...(b.lifecycleState === 'cancelled' ? [{ kind: 'cancellation', reason: 'Billed twice', version: 2, at: '2026-11-14T07:00:00.000Z' }] : []),
      ];
      return ok(route, { invoice: b, events });
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return state;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: 'Bills' }).click();
}

test('bills list, a paid tax invoice with lines, GST split, the doctor and payment, and its PDF read with the token', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await expect(page.getByRole('link', { name: /CarePlus Clinic/ })).toContainText('Unpaid');
  await page.getByRole('link', { name: /Sunrise Diagnostics/ }).click();
  await expect(page.getByRole('heading', { name: 'Sunrise Diagnostics' })).toBeVisible();
  await expect(page.getByText('Tax invoice SUN/2026-27/000123', { exact: false })).toBeVisible();
  await expect(page.getByText('Dr. Meena Iyer')).toBeVisible();
  await expect(page.getByText(/Paid by UPI on/)).toBeVisible();
  await expect(page.getByText('2 × ₹300.00 − ₹100.00 discount · GST 18%')).toBeVisible();
  const totals = page.getByLabel('Totals');
  await expect(totals).toContainText('CGST₹81.00');
  await expect(totals).toContainText('SGST₹81.00');
  await expect(totals).not.toContainText('IGST');
  await expect(totals).toContainText('Total₹1,062.00');
  await page.getByRole('button', { name: 'Get bill PDF' }).click();
  await expect(page.getByRole('link', { name: 'Open bill PDF' })).toHaveAttribute('href', /^blob:/);
  await expect(page.getByRole('link', { name: 'Save bill PDF' })).toHaveAttribute('download', 'SUN-2026-27-000123-v1.pdf');
  const pdf = backend.calls.filter((c) => c.path.startsWith(`/bills/${PAID}/pdf`));
  expect(pdf.map((c) => c.path)).toEqual([`/bills/${PAID}/pdf?version=1`]);
  expect(pdf[0]!.auth).toBe('Bearer t');
  expect(backend.calls.some((c) => c.path.startsWith('/specialists'))).toBe(false);
  expect(backend.calls.find((c) => c.path.startsWith('/bills?'))!.path).toBe('/bills?page=1&limit=20');
});

test('an unpaid bill across states shows IGST and says where to pay', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await page.getByRole('link', { name: /CarePlus Clinic/ }).click();
  await expect(page.getByText('Not paid yet. Pay at the CarePlus Clinic counter.')).toBeVisible();
  const totals = page.getByLabel('Totals');
  await expect(totals).toContainText('IGST₹45.00');
  await expect(totals).not.toContainText('CGST');
  await expect(page.getByText('Doctor', { exact: true })).toHaveCount(0);
});

test('a list that fails to load shows the server’s message and tries again', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.failList = 1;
  await signIn(page);
  await expect(page.getByText('Bills could not be loaded')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('link', { name: /Sunrise Diagnostics/ })).toBeVisible();
});

test('the PDF follows the bill’s version: a bill cancelled after its PDF was fetched starts again and gets the new version', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await page.getByRole('link', { name: /Sunrise Diagnostics/ }).click();
  await page.getByRole('button', { name: 'Get bill PDF' }).click();
  await expect(page.getByRole('link', { name: 'Save bill PDF' })).toHaveAttribute('download', 'SUN-2026-27-000123-v1.pdf');
  // Cancelled at the counter (version 2). The page reads the bill again when the customer comes back to it.
  Object.assign(backend.bills[PAID]!, { lifecycleState: 'cancelled', lifecycleVersion: 2 });
  await page.getByRole('link', { name: 'Bills' }).first().click();
  await page.getByRole('link', { name: /Sunrise Diagnostics/ }).click();
  await expect(page.getByText(/This bill was cancelled on .*: “Billed twice”/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Save bill PDF' })).toHaveCount(0); // never the v1 file under the new bill
  await page.getByRole('button', { name: 'Get bill PDF' }).click();
  await expect(page.getByRole('link', { name: 'Save bill PDF' })).toHaveAttribute('download', 'SUN-2026-27-000123-v2.pdf');
  expect(backend.calls.filter((c) => c.path.startsWith(`/bills/${PAID}/pdf`)).map((c) => c.path))
    .toEqual([`/bills/${PAID}/pdf?version=1`, `/bills/${PAID}/pdf?version=2`]);
});

test('Q14: a partly paid bill shows each payment with its methods and what is still due', async ({ page }) => {
  const backend = await mockBackend(page);
  Object.assign(backend.bills[UNPAID]!, { lifecycleState: 'partly_paid', lifecycleVersion: 1, paidMinor: 20000, dueMinor: 9500,
    events: [{ kind: 'payment', amountMinor: 20000, splits: [{ mode: 'cash', amountMinor: 5000 }, { mode: 'upi', amountMinor: 15000 }], version: 1, at: '2026-11-14T06:00:00.000Z' }] });
  await signIn(page);
  await expect(page.getByRole('link', { name: /CarePlus Clinic/ })).toContainText('Partly paid');
  await page.getByRole('link', { name: /CarePlus Clinic/ }).click();
  await expect(page.getByText('Paid ₹200.00 by Cash + UPI on', { exact: false })).toBeVisible();
  await expect(page.getByText('Partly paid: ₹95.00 is still due. Pay the rest at the CarePlus Clinic counter.')).toBeVisible();
});
