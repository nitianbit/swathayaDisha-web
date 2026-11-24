import { expect, test } from '@playwright/test';

/**
 * Phase 6 round 6a (docs/I18N_PLAN.md §4.2): the language start-up. Until a second language is released the app
 * starts in English, shows no language list and stores nothing. Signed out: every API call answers 401.
 */
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({
    status: 401, contentType: 'application/json', body: JSON.stringify({ error: 401, code: 'SESSION_ENDED', message: 'Please sign in again' }),
  }));
});

test('English by default: no language list while only English is offered, and nothing stored', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByLabel(/Language/)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('jansetu.lang'))).toBeNull();
});

test('a kept language this app does not offer yet is ignored', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('jansetu.lang', 'hi'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByLabel(/Language/)).toHaveCount(0);
});
