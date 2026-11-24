import { defineConfig, devices } from '@playwright/test';

/** Browser journeys against the dev server with every `/api/**` call mocked in the test (no backend needed). */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  // English on any machine (docs/I18N_PLAN.md §4.2): the app's first guess reads the browser language.
  use: { baseURL: 'http://127.0.0.1:5175', trace: 'retain-on-failure', locale: 'en-IN' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
