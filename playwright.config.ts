import { defineConfig } from '@playwright/test';

// E2E smoke suite. Runs against a locally-started dev server so the tests
// exercise the real bundle + API without needing a deployment.
// Run: npm run test:e2e
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1, // the gov-services fetches are slow and rate-limited; stay serial
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    viewport: { width: 390, height: 844 }, // mobile is the form factor that breaks
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Port 3100: 3000 belongs to Hermes' WhatsApp bridge in this sandbox.
    command: 'PORT=3100 npm run dev',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
