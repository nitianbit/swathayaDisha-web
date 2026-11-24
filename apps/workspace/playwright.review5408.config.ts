import { defineConfig, devices } from '@playwright/test';

/** TEMPORARY review config (port 5408, never reuses a server). Deleted after the review run. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:5408', trace: 'off' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'tablet', use: { ...devices['Galaxy Tab S4'] } },
  ],
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5408 --strictPort',
    url: 'http://127.0.0.1:5408',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
