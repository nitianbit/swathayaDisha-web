import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * WQ28: a doctor's patient records for one consultation (assisted booking round 3f, backend r30, design §25.17): its own
 * consultations, "Ask the patient", the request waiting, allowed (the other records listed and opened through the file
 * route), denied and ended; a lost answer to the request checked by reading again; another doctor's consultation and a
 * closed treating window show nothing. Mocked API.
 */
const DOC = 'd1'.repeat(12);
const CONSULT = 'c7'.repeat(12);
const OTHER = 'c9'.repeat(12);
const HOLDER = 'f1'.repeat(12);
const RX_BOOKING = 'b5'.repeat(12);
const LAB_BOOKING = 'b6'.repeat(12);
const NOW = new Date('2026-11-25T04:30:00.000Z'); // 10:00 in India
const DAY_AFTER = '2026-11-26T04:30:00.000Z';
const RX_FILE = `/api/static/bookings/${RX_BOOKING}/prescription-1.pdf`;
const LAB_FILE = `/api/static/partner-lab-reports/${LAB_BOOKING}/report-1.pdf`;

type Json = Record<string, unknown>;
interface Backend {
  calls: { method: string; path: string }[];
  request: Json | null;
  grant: Json | null;
  windowClosed: boolean;
  noApp: boolean;
  dropNextRequest: boolean;
}

const appointment = (o: Json = {}): Json => ({
  _id: CONSULT, userId: HOLDER, bookingType: 'consultation', bookingKind: 'scheduled', bookingDate: '20261125', bookingTime: '09:30', consultationMode: 'video',
  status: 'confirmed', paymentStatus: 'paid', price: 500, settlementSystem: 'ledger', updatedAt: '2026-11-25T03:00:00.000Z', ...o,
});
const others = {
  consultations: [{ bookingId: RX_BOOKING, date: '20261101', doctorName: 'Meena Iyer', specialization: 'Dermatology', consultationMode: 'video', diagnosis: 'Eczema',
    advice: 'Moisturise', medicines: [{ name: 'Cetirizine', dosage: '10 mg' }], testsAdvised: [], recommendationCode: null, prescribedAt: '2026-11-01T06:00:00.000Z', prescriptionFile: RX_FILE }],
  labReports: [{ labBookingId: LAB_BOOKING, labName: 'Sun Diagnostics', date: '2026-11-10', tests: ['Complete blood count'],
    releases: [{ file: LAB_FILE, releasedAt: '2026-11-11T06:00:00.000Z', signer: { name: 'Dr A Rao', kind: 'pathologist', registrationNumber: 'MCI-9' } }] }],
};

async function mockBackend(page: Page): Promise<Backend> {
  await page.clock.setFixedTime(NOW);
  const b: Backend = { calls: [], request: null, grant: null, windowClosed: false, noApp: false, dropNextRequest: false };
  const profile = { _id: DOC, name: 'Dr Asha Mehta', specialization: 'Cardiology', phone: '9000000020', isActive: true, isVerified: true };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const ok = (route: Route, data: unknown, status = 200) => json(route, status, { success: true, data });
  const refuse = (route: Route, status: number, code: string, message = 'refused') => json(route, status, { error: status, code, message });
  let live = false;
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = req.method();
    if (path === '/auth/session/refresh') {
      return live ? ok(route, { token: 't1', expiresIn: 900, principal: { userId: DOC, userType: 'specialist', sid: 's1' } }) : refuse(route, 401, 'SESSION_ENDED');
    }
    if (path.startsWith('/auth/session')) return ok(route, {});
    b.calls.push({ method, path: `${path}${url.search}` });
    if (path === '/auth/specialist/send') return ok(route, undefined);
    if (path === '/auth/specialist/verify') { live = true; return ok(route, { token: 't1', expiresIn: 900, user: {} }); }
    if (req.headers().authorization !== 'Bearer t1') return refuse(route, 401, 'UNAUTHORIZED');
    if (path === '/auth/profile') return ok(route, { user: profile, userRole: 'specialist' });
    if (path === '/specialists/me/appointments') return ok(route, url.search === '?view=month&yearMonth=202611' ? [appointment()] : []);
    // Another doctor's consultation is not this doctor's (the same 404 as a missing one).
    if (path === `/specialists/me/appointments/${CONSULT}`) return ok(route, { booking: appointment(), patient: { name: 'Asha Rao', phone: '9876543210' } });
    if (path === `/specialists/me/appointments/${OTHER}`) return refuse(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
    if (path === `/specialists/me/patients/${HOLDER}/history`) {
      if (url.searchParams.get('bookingId') !== CONSULT) return refuse(route, 404, 'BOOKING_NOT_FOUND', 'Booking not found');
      if (b.windowClosed) return refuse(route, 409, 'TREATING_WINDOW_CLOSED', 'This consultation is not open for treatment now');
      return ok(route, { patient: { name: 'Asha Rao', phone: '9876543210' },
        consultations: [{ bookingId: CONSULT, bookingDate: '20261125', bookingTime: '09:30', status: 'confirmed', consultationMode: 'video', prescription: null }],
        ...(b.grant ? { others } : {}),
        access: { window: { opensAt: '2026-11-25T03:50:00.000Z', closesAt: '2026-12-02T04:30:00.000Z' }, grant: b.grant, request: b.request } });
    }
    if (path === `/specialists/me/bookings/${CONSULT}/records-access/request` && method === 'POST') {
      b.request = { state: 'pending', createdAt: NOW.toISOString(), expiresAt: DAY_AFTER };
      if (b.dropNextRequest) { b.dropNextRequest = false; return route.abort('connectionreset'); }
      return ok(route, { requestId: 'a1'.repeat(12), state: 'pending', expiresAt: DAY_AFTER, channels: { app: !b.noApp, sms: false } }, 201);
    }
    if (path === '/file/fetch') return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: '%PDF-1.4\n%%EOF\n' });
    return refuse(route, 404, 'NOT_FOUND', `Not mocked: ${method} ${path}`);
  });
  return b;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Doctor', { exact: true }).check();
  await page.getByLabel('Mobile number').fill('9000000020');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
const others$ = (page: Page) => page.getByRole('region', { name: 'Other records' });
async function openFromAppointments(page: Page) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Appointments', exact: true }).click();
  await page.getByRole('link', { name: /^Patient’s records/ }).click();
  await expect(page.getByRole('heading', { name: 'Patient records', level: 1 })).toBeVisible();
}
async function ask(page: Page) {
  await others$(page).getByRole('button', { name: 'Ask the patient to see their other records' }).click();
  await expect(others$(page).getByText('The account holder is asked in the Jansetu app.', { exact: false })).toBeVisible();
  await others$(page).getByRole('button', { name: 'Yes, ask the patient' }).click();
}
const historyReads = (b: Backend) => b.calls.filter((c) => c.path.startsWith(`/specialists/me/patients/${HOLDER}/history`));
const nothingStored = async (page: Page, ...words: string[]) => {
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  for (const w of words) expect(stored).not.toContain(w);
};

test('ask, the patient allows it: the other records are listed and each opens through the file route (the read is the server’s to log)', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await openFromAppointments(page);
  await expect(page).toHaveURL(new RegExp(`#/doctor/appointments/${CONSULT}/records$`));
  await expect(page.getByRole('table', { name: 'Your consultations with this patient' })).toContainText('09:30');
  await expect(others$(page)).toContainText('Only your own consultations are shown.');
  await ask(page);
  await expect(others$(page).getByText('Asked. The patient answers in the Jansetu app.')).toBeVisible();
  await expect(others$(page)).toContainText('Waiting for the patient to answer in the Jansetu app, until');
  await expect(others$(page).getByRole('button', { name: 'Ask the patient to see their other records' })).toHaveCount(0);

  // The account holder allows it in the customer app.
  b.request = { state: 'approved', createdAt: NOW.toISOString(), expiresAt: DAY_AFTER };
  b.grant = { at: NOW.toISOString(), expiresAt: '2027-11-25T04:30:00.000Z', via: 'app' };
  await others$(page).getByRole('button', { name: 'Check again' }).click();
  const table = page.getByRole('table', { name: 'Records from other doctors and labs, newest first' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').nth(1)).toContainText('Sun Diagnostics');
  await expect(table.getByRole('row').nth(1)).toContainText('Lab report: Complete blood count');
  await expect(table.getByRole('row').nth(2)).toContainText('Meena Iyer, Dermatology');
  await expect(table.getByRole('row').nth(2)).toContainText('Prescription');
  await expect(others$(page).getByText('Only your own consultations are shown.')).toHaveCount(0);
  await table.getByRole('button', { name: /^Open: Prescription/ }).click();
  await expect(page.getByTitle('Patient record')).toBeVisible();
  await table.getByRole('button', { name: /^Open: Lab report/ }).click();
  const fetches = () => b.calls.filter((c) => c.path.startsWith('/file/fetch')).map((c) => decodeURIComponent(c.path));
  await expect.poll(() => fetches().length).toBe(2);
  expect(fetches()[0]).toContain(`bookings/${RX_BOOKING}/prescription-1.pdf`);
  expect(fetches()[1]).toContain(`partner-lab-reports/${LAB_BOOKING}/report-1.pdf`);
  expect(historyReads(b).every((c) => c.path.endsWith(`?bookingId=${CONSULT}`))).toBe(true);
  // On opening, after asking and on "Check again" only (no read on focus): every read is logged by the server.
  expect(historyReads(b)).toHaveLength(3);
  await nothingStored(page, 'Asha Rao', 'Meena', 'Eczema', HOLDER);
});

test('the patient denies it: said, and the doctor may ask again; a patient without the app is said when asking', async ({ page }) => {
  const b = await mockBackend(page);
  b.noApp = true;
  await signIn(page);
  await openFromAppointments(page);
  await ask(page);
  await expect(others$(page).getByText('The patient hasn’t used the Jansetu app yet; they can’t approve until they sign in.', { exact: false })).toBeVisible();
  b.request = { state: 'denied', createdAt: NOW.toISOString(), expiresAt: DAY_AFTER };
  await others$(page).getByRole('button', { name: 'Check again' }).click();
  await expect(others$(page).getByText('The patient did not allow it. You can ask again.')).toBeVisible();
  await expect(others$(page).getByRole('button', { name: 'Ask the patient to see their other records' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Records from other doctors and labs, newest first' })).toHaveCount(0);
});

test('an ended request (24 hours, or the treating time over): said, ask again; a lost answer to asking is checked by reading again', async ({ page }) => {
  const b = await mockBackend(page);
  b.request = { state: 'pending', createdAt: '2026-11-24T03:00:00.000Z', expiresAt: '2026-11-25T03:00:00.000Z' }; // past its expiry
  await signIn(page);
  await page.goto(`/#/doctor/appointments/${CONSULT}/records`);
  await expect(others$(page).getByText('The request ended before the patient answered. You can ask again.')).toBeVisible();
  b.dropNextRequest = true;
  await ask(page);
  await expect(others$(page).getByText(/The outcome of asking is not known yet/)).toBeVisible();
  await others$(page).getByRole('button', { name: 'Check whether it was recorded' }).click();
  await expect(others$(page)).toContainText('Waiting for the patient to answer in the Jansetu app, until');
  expect(b.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/records-access/request'))).toHaveLength(1);
});

test('another doctor’s consultation (or none) shows nothing; a closed treating window says so and shows no records', async ({ page }) => {
  const b = await mockBackend(page);
  await signIn(page);
  await page.goto(`/#/doctor/appointments/${OTHER}/records`);
  await expect(page.getByText('Consultation not found', { exact: true })).toBeVisible();
  expect(historyReads(b)).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Ask the patient to see their other records' })).toHaveCount(0);
  b.windowClosed = true;
  await page.goto(`/#/doctor/appointments/${CONSULT}/records`);
  await expect(page.getByText('This consultation is not open for treatment now, so its patient’s records are not shown.', { exact: false })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask the patient to see their other records' })).toHaveCount(0);
});
