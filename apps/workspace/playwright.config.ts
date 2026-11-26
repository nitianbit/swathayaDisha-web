import { defineConfig, devices } from '@playwright/test';

/** Browser journeys against the dev server with every `/api/**` call mocked in the test (no backend needed). */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'list',
  // English on any machine (docs/I18N_PLAN.md §4.2): the app's first guess reads the browser language.
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'retain-on-failure', locale: 'en-IN' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // WQ54b: a tablet held sideways (1138 px): up to 760 px is the phone layout (the menu behind More), which the 390 px
    // journeys in pharmacy-home.spec.ts cover.
    { name: 'tablet', use: { ...devices['Galaxy Tab S4 landscape'] } },
  ],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
