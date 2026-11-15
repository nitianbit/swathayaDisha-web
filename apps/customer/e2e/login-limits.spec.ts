import { expect, test, type Route } from '@playwright/test';

/** O1: the sign-in screen with the backend's OTP limits (429 + Retry-After; a burnt code). */
test('a refused resend counts down the server’s wait; a burnt code clears the field and asks for a new one', async ({ page }) => {
  let sends = 0;
  const json = (route: Route, status: number, body: unknown, headers: Record<string, string> = {}) =>
    route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path === '/auth/user/send') {
      sends++;
      if (sends === 1) return json(route, 200, { success: true });
      return json(route, 429, { error: 429, code: 'OTP_SEND_LIMIT', message: 'Too many codes requested. Please try again in 50 minutes.', retryAfter: 3000 },
        { 'Retry-After': '3000' });
    }
    if (path === '/auth/user/verify') {
      return json(route, 429, { error: 429, code: 'OTP_ATTEMPTS_EXCEEDED', message: 'Too many incorrect codes. Please request a new code.' });
    }
    return json(route, 401, { error: 401, message: 'Please sign in again' });
  });
  await page.clock.install();
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('111111');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many incorrect codes. Please request a new code.');
  await expect(page.getByLabel('6-digit code')).toHaveValue('');
  // The 30-second resend gap is shown by the app; skip it and resend: the server refuses for 50 minutes.
  // The countdown re-arms a 1-second timer after each render, so the fake clock advances one second at a time.
  for (let i = 0; i < 31; i++) await page.clock.runFor(1000);
  await expect(page.getByRole('button', { name: 'Resend code' })).toBeEnabled();
  await page.getByRole('button', { name: 'Resend code' }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many codes requested. Please try again in 50 minutes.');
  await expect(page.getByRole('button', { name: /Resend code in (2999|3000)s/ })).toBeDisabled();
});

test('a refused first send waits on that number only; another number can still be used', async ({ page }) => {
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/v1', '');
    if (path === '/auth/user/send') {
      const phone = (req.postDataJSON() as { phone: string }).phone;
      if (phone === '9876543210') return json(route, 429, { error: 429, code: 'OTP_SEND_LIMIT', message: 'Too many codes requested. Please try again in 50 minutes.', retryAfter: 3000 });
      return json(route, 200, { success: true });
    }
    return json(route, 401, { error: 401, message: 'Please sign in again' });
  });
  await page.goto('/');
  await page.getByLabel('Mobile number').fill('9876543210');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many codes requested. Please try again in 50 minutes.');
  await expect(page.getByRole('button', { name: /Send code in \d+s/ })).toBeDisabled();
  await page.getByLabel('Mobile number').fill('9876543211');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
});
