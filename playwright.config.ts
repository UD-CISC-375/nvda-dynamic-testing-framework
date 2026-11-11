import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  retries: process.env.CI ? 2 : 0,
  // Print each test as it runs, and also write an HTML report.
  // Locally the report opens in the browser when the run ends (Ctrl+C in the
  // terminal stops the report server). On CI nobody is there to look or press
  // Ctrl+C, so it stays closed.
  reporter: [
    ['list'],
    // Keep Playwright's HTML report for traces, but do not auto-open it.
    // The accessible reporter opens instead, with the graphical / Markdown toggle.
    ['html', { open: 'never' }],
    ['./accessible-markdown-reporter.ts'],
  ],
  use: {
    trace: process.env.CI ? 'on-first-retry' : 'off',
    // Team Y's site. Tests call page.goto('#/...') and Playwright prepends this.
    // The trailing slash matters: without it the relative URL would replace
    // "nvda-dynamic-testing-webpage" instead of being appended after it.
    baseURL: 'https://UD-CISC-375.github.io/nvda-dynamic-testing-webpage/',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
