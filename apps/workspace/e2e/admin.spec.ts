import { expect, test, type Page, type Route } from '@playwright/test';

const ADMIN = 'ad'.repeat(12);
const ORDER = '4'.repeat(24);
const MANUAL = '5'.repeat(24);
const B1 = '61'.repeat(12);
const B2 = '62'.repeat(12);

interface Backend { calls: { path: string; body: unknown }[]; refunds: Record<string, unknown>[]; cancels: Record<string, unknown>[] }

const fingerprint = (refs: { ref: string; cancelled: boolean }[]) =>
  refs.map((r) => `${r.ref}:${r.cancelled ? 1 : 0}`).sort().join('|').padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a');

function cancellation(id: string, patient: string, refs: { ref: string; cancelled: boolean }[], needsAdmin = true) {
  return { _id: id, status: 'cancellation_requested', integration: 'healthians', bookingDate: '20261120', bookingTime: '09:00',
    patientName: patient, labName: 'City Lab', packageNames: ['Full body'], price: 1499, paymentStatus: 'paid', providerRefs: refs,
    obligations: fingerprint(refs),
    cancel: { by: 'user', at: '2026-11-14T05:00:00.000Z', state: 'unknown', calls: 5, needsAdmin, blockedBy: 'provider_unknown', error: 'timeout' } };
}

async function mockBackend(page: Page): Promise<Backend> {
  const state: Backend = {
    calls: [],
    refunds: [
      { _id: ORDER, orderNumber: 'PO-9001', pharmacyId: 'p', status: 'rejected', prescriptionRefund: { cause: 'prescription_rejected', status: 'wallet_pending', walletAmount: 350, gatewayAmountPaise: 0, lastError: 'WALLET_INACTIVE', updatedAt: '2026-11-14T04:00:00.000Z' } },
      { _id: 'c3'.repeat(12), orderNumber: 'PO-9003', pharmacyId: 'p', status: 'cancelled', prescriptionRefund: { cause: 'order_cancelled', status: 'source_processing', walletAmount: 0, gatewayAmountPaise: 50000 } },
      { _id: MANUAL, orderNumber: 'PO-9002', pharmacyId: 'p', status: 'cancelled', prescriptionRefund: { cause: 'delivery_refused', status: 'manual_review', walletAmount: 120, gatewayAmountPaise: 0, lastError: 'PRIOR_REFUND_AMOUNT_MISMATCH' } },
    ],
    cancels: [
      cancellation(B1, 'Meera Rao', [{ ref: 'HL-100', cancelled: true }, { ref: 'HL-101', cancelled: false }]),
      cancellation(B2, 'Arun Das', []),
    ],
  };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace('/api/v1', '');
    const body = req.method() === 'POST' ? req.postDataJSON() : null;
    if (path === '/auth/admin/send') return json(route, 200, { success: true });
    if (path === '/auth/admin/verify') return json(route, 200, { success: true, data: { token: 't1', user: {} } });
    if (req.headers().authorization !== 'Bearer t1') return json(route, 401, { error: 401, message: 'Authentication is required' });
    if (path === '/auth/profile') return json(route, 200, { success: true, data: { user: { _id: ADMIN, name: 'Ops Admin' }, userRole: 'admin' } });
    if (path === '/pharmacy-orders/prescription-refunds/attention') return json(route, 200, { success: true, data: state.refunds });
    if (path === `/pharmacy-orders/${ORDER}/prescription-refund/retry`) {
      state.calls.push({ path, body });
      state.refunds = state.refunds.filter((r) => r._id !== ORDER);
      return json(route, 200, { success: true, data: {} });
    }
    if (path === '/external-bookings/bookings/cancellations/attention') {
      const scope = url.searchParams.get('scope') ?? 'admin';
      const items = state.cancels.filter((c) => scope === 'open' || (c.cancel as { needsAdmin: boolean }).needsAdmin);
      return json(route, 200, { success: true, data: items, pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 } });
    }
    const m = /^\/external-bookings\/bookings\/(\w+)\/reconcile-cancellation$/.exec(path);
    if (m) {
      state.calls.push({ path: `${m[1]}/reconcile`, body });
      const current = state.cancels.find((c) => c._id === m[1]) as { providerRefs: { ref: string; cancelled: boolean }[] } | undefined;
      if (current && (body as { expectedObligations?: string }).expectedObligations !== fingerprint(current.providerRefs)) {
        return json(route, 409, { error: 409, code: 'EXTERNAL_OBLIGATIONS_CHANGED', message: 'The provider bookings changed since you checked them; review them again' });
      }
      state.cancels = state.cancels.filter((c) => c._id !== m[1]);
      return json(route, 200, { success: true, data: { _id: m[1], status: 'cancelled' } });
    }
    return json(route, 404, { error: 404, message: 'Not found' });
  });
  return state;
}

async function signIn(page: Page, to: string) {
  await page.goto('/');
  await page.getByLabel('Admin').check();
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await page.getByRole('link', { name: to }).first().click();
}

test('admin sees no pharmacy pages, and pharmacy pages do not exist for the role', async ({ page }) => {
  await mockBackend(page);
  await signIn(page, 'Refunds needing attention');
  await expect(page.getByRole('link', { name: 'Orders' })).toHaveCount(0);
  await page.goto('/#/pharmacy/stock');
  await expect(page.getByText('Page not found')).toBeVisible();
});

test('refunds: a waiting wallet credit can be retried; a finance review cannot be acted on here', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'Refunds needing attention');
  const manual = page.getByRole('row').filter({ hasText: 'PO-9002' });
  await expect(manual).toContainText('Needs manual review by finance');
  await expect(manual.getByRole('button')).toHaveCount(0);
  const waiting = page.getByRole('row').filter({ hasText: 'PO-9001' });
  await expect(waiting).toContainText('The customer’s wallet is inactive (WALLET_INACTIVE)');
  // WQ11b: every cause has words (a cancelled order's refund too), never a raw code.
  await expect(page.getByRole('row').filter({ hasText: 'PO-9003' })).toContainText('Order cancelled');
  await expect(page.getByText('order_cancelled')).toHaveCount(0);
  await waiting.getByRole('button', { name: 'Retry' }).click();
  await waiting.getByRole('button', { name: 'Retry now' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'PO-9001' })).toHaveCount(0);
  expect(backend.calls).toEqual([{ path: `/pharmacy-orders/${ORDER}/prescription-refund/retry`, body: null }]);
});

test('external cancellations: the admin records what the provider says; the options follow the provider references', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'External cancellations');
  const meera = page.getByRole('listitem').filter({ hasText: 'Meera Rao' });
  const arun = page.getByRole('listitem').filter({ hasText: 'Arun Das' });
  await expect(meera).toContainText('HL-101');
  await expect(meera.getByRole('button', { name: 'No booking at the provider…' })).toBeDisabled();
  // With no references both are possible: "cancelled" also settles an unknown reschedule, which "absent" does not.
  await expect(arun.getByRole('button', { name: 'Provider confirms cancelled…' })).toBeEnabled();
  await expect(arun.getByRole('button', { name: 'No booking at the provider…' })).toBeEnabled();

  await meera.getByRole('button', { name: 'Provider confirms cancelled…' }).click();
  await expect(meera.getByText(/including HL-101/)).toBeVisible();
  await meera.getByRole('button', { name: 'Record: cancelled at the provider' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Meera Rao' })).toHaveCount(0);

  await arun.getByRole('button', { name: 'No booking at the provider…' }).click();
  await arun.getByRole('button', { name: 'Record: no provider booking exists' }).click();
  await expect(page.getByText('Nothing is waiting for an admin')).toBeVisible();
  expect(backend.calls).toEqual([
    { path: `${B1}/reconcile`, body: { providerOutcome: 'cancelled', expectedObligations: fingerprint([{ ref: 'HL-100', cancelled: true }, { ref: 'HL-101', cancelled: false }]) } },
    { path: `${B2}/reconcile`, body: { providerOutcome: 'absent', expectedObligations: fingerprint([]) } },
  ]);
});

test('a provider booking that appears during the review makes the confirmation stale: refused, shown, re-checked', async ({ page }) => {
  const backend = await mockBackend(page);
  await signIn(page, 'External cancellations');
  const meera = page.getByRole('listitem').filter({ hasText: 'Meera Rao' });
  await meera.getByRole('button', { name: 'Provider confirms cancelled…' }).click();
  // Meanwhile a late provider result adds HL-102.
  const row = backend.cancels.find((c) => c._id === B1) as { providerRefs: { ref: string; cancelled: boolean }[]; obligations: string };
  row.providerRefs = [...row.providerRefs, { ref: 'HL-102', cancelled: false }];
  row.obligations = fingerprint(row.providerRefs);
  await meera.getByRole('button', { name: 'Record: cancelled at the provider' }).click();

  const fresh = page.getByRole('listitem').filter({ hasText: 'Meera Rao' });
  await expect(fresh).toContainText('HL-102');
  await expect(fresh.getByText(/changed while you were reviewing/)).toBeVisible();
  await expect(fresh.getByRole('button', { name: 'Provider confirms cancelled…' })).toBeDisabled();
  await fresh.getByRole('button', { name: 'I have checked the updated list' }).click();
  await fresh.getByRole('button', { name: 'Provider confirms cancelled…' }).click();
  await expect(fresh.getByText(/including HL-101, HL-102/)).toBeVisible();
  await fresh.getByRole('button', { name: 'Record: cancelled at the provider' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Meera Rao' })).toHaveCount(0);
  const sent = backend.calls.map((c) => (c.body as { expectedObligations: string }).expectedObligations);
  expect(sent[0]).not.toBe(sent[1]);
  expect(sent[1]).toBe(row.obligations);
});

test('external cancellations: "All open" also shows ones still retried automatically, with a caution', async ({ page }) => {
  const backend = await mockBackend(page);
  backend.cancels.push(cancellation('63'.repeat(12), 'Lata Iyer', [{ ref: 'HL-300', cancelled: false }], false));
  await signIn(page, 'External cancellations');
  await expect(page.getByText('Lata Iyer')).toHaveCount(0);
  await page.getByRole('button', { name: 'All open' }).click();
  const lata = page.getByRole('listitem').filter({ hasText: 'Lata Iyer' });
  await expect(lata.getByText(/Still being retried automatically/)).toBeVisible();
});
