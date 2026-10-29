import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
const baseURL = process.env.BASE_URL ?? 'https://UD-CISC-375.github.io/nvda-dynamic-testing-webpage/';

export default defineConfig({
  testDir: 'tests',
  retries: isCI ? 2 : 0,
  // Print each test as it runs, and also write an HTML report.
  // Locally the report opens in the browser when the run ends (Ctrl+C in the
  // terminal stops the report server). On CI nobody is there to look or press
  // Ctrl+C, so it stays closed.
  reporter: [['list'], ['html', { open: isCI ? 'never' : 'always' }]],
  use: {
    trace: isCI ? 'on-first-retry' : 'off',
    // Team Y's site. Tests call page.goto('#/...') and Playwright prepends this.
    // The trailing slash matters: without it the relative URL would replace
    // "nvda-dynamic-testing-webpage" instead of being appended after it.
    baseURL,
  },
  webServer: isCI
    ? {
        command: 'npx serve site-root -l 4173',
        url: 'http://127.0.0.1:4173/nvda-dynamic-testing-webpage/',
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
  projects: [
    // Default: Playwright clicks the menu button itself.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Manual: a visible browser opens and a person clicks the menu button.
    // Tests check testInfo.project.name to know which mode they're in.
    {
      name: 'manual',
      use: { ...devices['Desktop Chrome'], headless: false },
      timeout: 120_000, // per test; leaves time to find and click the button
    },
  ],
});
