import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  // Print each test as it runs, and also write an HTML report.
  // Locally the report opens in the browser when the run ends (Ctrl+C in the
  // terminal stops the report server). On CI nobody is there to look or press
  // Ctrl+C, so it stays closed.
  reporter: [['list'], ['html', { open: process.env.CI ? 'never' : 'always' }]],
  use: {
    // Team Y's site. Tests call page.goto('#/...') and Playwright prepends this.
    // The trailing slash matters: without it the relative URL would replace
    // "nvda-dynamic-testing-webpage" instead of being appended after it.
    baseURL: 'https://UD-CISC-375.github.io/nvda-dynamic-testing-webpage/',
    // Pause this many ms before each browser action so people can watch.
    // Unset (0) normally; the presenter server (presenter/server.mjs) sets it.
    launchOptions: { slowMo: Number(process.env.SLOW_MO) || 0 },
  },
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
