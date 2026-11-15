import { expect, test, type Page, type Route } from '@playwright/test';

const ME = 'b'.repeat(24); // the signed-in pharmacy
const OTHER = 'c'.repeat(24);
const ORDER_ID = 'a'.repeat(24);
// Stored the way the backend's upload service stores them; the file route serves them only under /api/v1/file/static/.
const DOCS = ['/api/static/pharmacy/rx/one.png', '/api/static/pharmacy/rx/two.pdf'];
const served = (stored: string) => stored.replace('/api/static/', '/api/v1/file/static/');
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const BROKEN_PNG = Buffer.concat([PNG.subarray(0, 8), Buffer.from('this is not image data')]);

function order(overrides: Record<string, unknown> = {}) {
  return {
    _id: ORDER_ID, orderNumber: 'PO-1001', pharmacyId: ME, orderType: 'online', status: 'placed',
    items: [{ medicineId: 'm1', medicineName: 'Amoxicillin 500mg', orderedQty: 10, unitPrice: 12, lineTotal: 120 }],
    grandTotal: 120, paymentStatus: 'paid', prescriptionUrls: DOCS, prescriptionStatus: 'pending',
    createdAt: '2026-11-14T05:30:00.000Z', ...overrides,
  };
}

interface Backend {
  reviews: Record<string, unknown>[];
  order: Record<string, unknown>;
  files: Record<string, { type: string; body: Buffer | string; delayMs?: number; status?: number }>;
  signIns: number;
  /** P9: the pharmacy's registered pharmacist (Settings); null = none yet. */
  pharmacist: { name: string; registrationNumber: string } | null;
}

async function mockBackend(page: Page, role: 'pharmacy' | 'admin' = 'pharmacy'): Promise<Backend> {
  const state: Backend = {
    reviews: [], order: order(), signIns: 0, pharmacist: { name: 'Ravi Kumar', registrationNumber: 'KA/PH/12345' },
    files: {
      [served(DOCS[0]!)]: { type: 'image/png', body: PNG },
      [served(DOCS[1]!)]: { type: 'application/octet-stream', body: '%PDF-1.4\n%%EOF' },
    },
  };
  const tokens = new Set<string>();
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const token = (req.headers().authorization ?? '').replace('Bearer ', '');

    if (/^\/auth\/(admin|pharmacy)\/send$/.test(path)) return json(route, 200, { success: true, message: 'OTP sent' });
    if (/^\/auth\/(admin|pharmacy)\/verify$/.test(path)) {
      const body = req.postDataJSON() as { otp: string };
      if (body.otp !== '123456') return json(route, 401, { error: 401, message: 'Invalid or expired OTP' });
      state.signIns += 1;
      const issued = `token-${state.signIns}`;
      tokens.add(issued);
      return json(route, 200, { success: true, data: { token: issued, user: { name: 'Asha Medicals' } } });
    }
    if (!tokens.has(token)) return json(route, 401, { error: 401, message: 'Authentication is required' });
    if (path === '/auth/profile') {
      return json(route, 200, { success: true, data: { user: { _id: ME, name: 'Asha Medicals' }, userRole: role } });
    }
    if (path === '/pharmacies/me/profile') return json(route, 200, { success: true, data: { _id: ME, name: 'Asha Medicals', pharmacist: state.pharmacist } });
    if (path === '/pharmacies/me/pharmacist' && req.method() === 'PUT') {
      state.pharmacist = req.postDataJSON() as { name: string; registrationNumber: string };
      return json(route, 200, { success: true, data: { pharmacist: state.pharmacist } });
    }
    if (path === '/pharmacy-orders/prescription-reviews' && req.method() === 'GET') {
      const o = state.order;
      const listed = o.pharmacyId === ME && o.prescriptionStatus === 'pending' && ['placed', 'accepted'].includes(String(o.status));
      const items = listed ? [{ ...o, customerId: { _id: 'd'.repeat(24), name: 'Meera Rao', phone: '9000000000' } }] : [];
      return json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
    }
    if (path === `/pharmacy-orders/${ORDER_ID}` && req.method() === 'GET') return json(route, 200, { success: true, data: state.order });
    if (path === `/pharmacy-orders/${ORDER_ID}/prescription-review` && req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>;
      state.reviews.push(body);
      const approved = body.decision === 'approve';
      state.order = order({
        prescriptionStatus: approved ? 'approved' : 'rejected', status: approved ? 'placed' : 'rejected',
        prescriptionReview: {
          decision: approved ? 'approved' : 'rejected', pharmacistName: state.pharmacist?.name,
          pharmacistRegistrationNumber: state.pharmacist?.registrationNumber, reason: body.reason,
          reviewedDocumentCount: (state.order.prescriptionUrls as string[]).length,
          prescriptionAttached: (state.order.prescriptionUrls as string[]).length > 0, reviewedAt: '2026-11-14T06:00:00.000Z',
        },
      });
      return json(route, 200, { success: true, data: state.order });
    }
    if (path === '/file/fetch') {
      const file = state.files[url.searchParams.get('url') ?? ''];
      if (!file) return json(route, 404, { success: false, message: 'File not found' });
      if (file.delayMs) await new Promise((r) => setTimeout(r, file.delayMs));
      if (file.status) return json(route, file.status, { error: file.status, message: 'Token expired' });
      return route.fulfill({ status: 200, contentType: file.type, body: file.body });
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return state;
}

async function signIn(page: Page, role: 'Pharmacy staff' | 'Admin' = 'Pharmacy staff') {
  if (!page.url().startsWith('http')) await page.goto('/');
  await page.getByLabel(role).check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  // Lands on Home, or on the page the previous (expired) session was showing.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function openOrder(page: Page) {
  await page.getByRole('link', { name: 'Prescription review' }).first().click();
  await expect(page.getByText('1 waiting')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Meera Rao' })).toBeVisible();
  await page.getByRole('link', { name: 'PO-1001' }).click();
  await expect(page.getByRole('heading', { name: 'Order PO-1001' })).toBeVisible();
}

async function readDocument(page: Page, n: number) {
  await page.getByRole('button', { name: `Document ${n}` }).click();
  const ack = page.getByLabel(`I have read document ${n} and it is legible`);
  await expect(ack).toBeEnabled();
  await ack.check();
}

/** P9: the pharmacist is on file (Settings); the decision shows who it records. */
async function fillReviewer(page: Page) {
  await expect(page.getByText('Deciding as Ravi Kumar (KA/PH/12345).')).toBeVisible();
}

test('a wrong code is refused and the user can retry', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid or expired OTP');
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Asha Medicals' })).toBeVisible();
});

test('approval needs every document displayed and confirmed; stored URLs are sent back verbatim', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await openOrder(page);

  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeDisabled();
  await page.getByRole('button', { name: 'Document 1' }).click();
  await expect(page.getByRole('img', { name: 'Prescription document 1' })).toBeVisible();
  await page.getByLabel('I have read document 1 and it is legible').check();
  await expect(approve).toBeDisabled();
  // Served as application/octet-stream, recognised as a PDF by its bytes.
  await page.getByRole('button', { name: 'Document 2' }).click();
  await expect(page.locator('iframe[title="Prescription document 2"]')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open document 2 in a new tab' })).toBeVisible();
  await page.getByLabel('I have read document 2 and it is legible').check();
  await expect(page.getByText('Read', { exact: true })).toHaveCount(2);
  await expect(approve).toBeEnabled();

  await fillReviewer(page);
  await approve.click();

  await expect(page.getByText('Prescription approved. The order can be packed.')).toBeVisible();
  // One button: the server records the pharmacy's registered pharmacist.
  expect(backend.reviews).toEqual([{ decision: 'approve', expectedRevision: 0, reviewedPrescriptionUrls: DOCS }]);
  await page.getByRole('link', { name: 'Back to the queue' }).click();
  await expect(page.getByText('No prescriptions waiting')).toBeVisible();
});

test('a corrupt image cannot be confirmed, so approval stays locked; rejection is still possible', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.files[served(DOCS[0]!)] = { type: 'image/png', body: BROKEN_PNG };
  await signIn(page);
  await openOrder(page);
  await page.getByRole('button', { name: 'Document 1' }).click();
  await expect(page.getByText('Document 1: This file could not be displayed.')).toBeVisible();
  await expect(page.getByText('Could not open')).toBeVisible();
  await readDocument(page, 2);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();

  await fillReviewer(page);
  await page.getByRole('button', { name: 'Reject…' }).click();
  await page.getByLabel('Reason for rejection').fill('Prescription image is unreadable; please upload a clear copy.');
  await page.getByRole('button', { name: 'Confirm rejection' }).click();
  await expect(page.getByText('Prescription rejected.')).toBeVisible();
  expect(backend.reviews[0]).toMatchObject({ decision: 'reject', reviewedPrescriptionUrls: DOCS });
});

test('a file the page will not render is download-only and must be downloaded before it can be confirmed', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.files[served(DOCS[0]!)] = { type: 'image/png', body: '<html><script>window.pwned=1</script></html>' };
  await signIn(page);
  await openOrder(page);
  await page.getByRole('button', { name: 'Document 1' }).click();
  await expect(page.getByText('This file type cannot be shown here.')).toBeVisible();
  const ack = page.getByLabel('I have read document 1 and it is legible');
  await expect(ack).toBeDisabled();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download document 1 to read it' }).click();
  await download;
  await expect(ack).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

test('rejecting needs a reason and a confirmation', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page);
  await openOrder(page);
  await fillReviewer(page);
  await page.getByRole('button', { name: 'Reject…' }).click();
  await page.getByRole('button', { name: 'Confirm rejection' }).click();
  await expect(page.getByText('Tell the customer why (at least 3 characters).')).toBeVisible();
  expect(backend.reviews).toHaveLength(0);
  await page.getByLabel('Reason for rejection').fill('Prescription is older than six months.');
  await page.getByRole('button', { name: 'Confirm rejection' }).click();
  await expect(page.getByText('Prescription rejected.')).toBeVisible();
  expect(backend.reviews[0]).toMatchObject({ decision: 'reject', reason: 'Prescription is older than six months.' });
});

test('an order this pharmacy buys, or one already cancelled, is read-only', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.order = order({ pharmacyId: OTHER, buyerPharmacyId: ME });
  await signIn(page);
  await page.goto(`/#/pharmacy/prescriptions/${ORDER_ID}`);
  await expect(page.getByText("Your pharmacy is the buyer on this order.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

  backend.order = order({ status: 'cancelled' });
  await page.reload(); // memory-only session: sign in again; the page that was open is kept
  await signIn(page);
  await expect(page.getByText('This order is cancelled, so its prescription can no longer be reviewed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject…' })).toHaveCount(0);
});

test("a late 401 from a previous sign-in does not sign out the next one", async ({ page }) => {
  const backend = await mockBackend(page);
  backend.files[served(DOCS[0]!)] = { type: 'image/png', body: PNG, delayMs: 1500, status: 401 };
  await signIn(page);
  await openOrder(page);
  await page.getByRole('button', { name: 'Document 1' }).click(); // answered 1.5 s later with 401 for token-1
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Welcome, Asha Medicals' })).toBeVisible(); // sign-out reset the page
  await page.waitForTimeout(2000);
  await expect(page.getByRole('heading', { name: 'Welcome, Asha Medicals' })).toBeVisible();
  await expect(page.getByText('Your session has ended.')).toHaveCount(0);
});

test('an expired session returns to sign-in with a notice and keeps no token', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  // The server now treats the token as expired.
  await page.route('**/api/v1/pharmacy-orders/prescription-reviews**', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 401, message: 'Token expired' }) }));
  await page.getByRole('link', { name: 'Prescription review' }).first().click();
  await expect(page.getByText('Your session has ended. Please sign in again.')).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('token-');
});

test('a reload signs the user out (token is memory-only)', async ({ page }) => {
  await mockBackend(page);
  await signIn(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('an admin has no prescription review page (deny by default)', async ({ page }) => {
  await mockBackend(page, 'admin');
  await signIn(page, 'Admin');
  await expect(page.getByRole('link', { name: 'Prescription review' })).toHaveCount(0);
  await page.goto(`/#/pharmacy/prescriptions/${ORDER_ID}`);
  await expect(page.getByText('Page not found')).toBeVisible();
});

test('the server-side role decides: a pharmacy account choosing Admin is refused', async ({ page }) => {
  await mockBackend(page, 'pharmacy');
  await page.goto('/');
  await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('This account cannot use the staff workspace.');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('P9: without a pharmacist on file nothing can be decided; Settings saves one and approval becomes one button', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.pharmacist = null;
  await signIn(page);
  await openOrder(page);
  await expect(page.getByText("Add your pharmacist's name and registration number first", { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject…' })).toBeDisabled();
  await page.getByRole('link', { name: 'Go to Settings' }).click();
  await page.getByLabel('Pharmacist name').fill('Ravi Kumar');
  await page.getByLabel('Registration number').fill('#');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Enter the pharmacist registration number.')).toBeVisible();
  await page.getByLabel('Registration number').fill('KA/PH/12345');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(backend.pharmacist).toEqual({ name: 'Ravi Kumar', registrationNumber: 'KA/PH/12345' });
  await page.goto(`/#/pharmacy/prescriptions/${ORDER_ID}`);
  await expect(page.getByText('Deciding as Ravi Kumar (KA/PH/12345).')).toBeVisible();
});

test('P9: an order with no prescription attached can be approved; the record says none was attached', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.order = order({ prescriptionUrls: [] });
  await signIn(page);
  await openOrder(page);
  await expect(page.getByText('The customer has not attached a prescription.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Prescription approved. The order can be packed.')).toBeVisible();
  await expect(page.getByText('0 (no prescription attached)')).toBeVisible();
  expect(backend.reviews).toEqual([{ decision: 'approve', expectedRevision: 0, reviewedPrescriptionUrls: [] }]);
});

test('P9: the decision names the version on screen', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.order = order({ revision: 3 });
  await signIn(page);
  await openOrder(page);
  await page.getByRole('button', { name: 'Reject…' }).click();
  await page.getByLabel('Reason for rejection').fill('Prescription is older than six months.');
  await page.getByRole('button', { name: 'Confirm rejection' }).click();
  await expect(page.getByText('Prescription rejected.')).toBeVisible();
  expect(backend.reviews[0]).toMatchObject({ decision: 'reject', expectedRevision: 3 });
});
