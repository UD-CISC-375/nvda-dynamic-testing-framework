import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Sortable Table Scenario', () => {
  
  test('accessible variant - keyboard driven navigation and ARIA attributes', async ({ page, baseURL }) => {
    // 1. Open accessible variant (use baseURL from config or fallback to local dev server)
    const host = baseURL || 'http://localhost:5173';
    await page.goto(`${host}/#/dynamic/sortable-table?variant=accessible`);

    // 2. Check starting state: caption "Employees" exists; no columnheader has aria-sort
    const caption = page.locator('caption');
    await expect(caption).toHaveText('Employees');

    const headersWithSort = page.locator('th[aria-sort]');
    await expect(headersWithSort).toHaveCount(0);

    // 3. Focus Name button and press Enter
    const nameButton = page.getByRole('button', { name: 'Name' });
    await nameButton.focus();
    await page.keyboard.press('Enter');

    // 4. Check ascending state
    const nameHeader = page.getByRole('columnheader', { name: 'Name' });
    await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

    const status = page.getByRole('status');
    await expect(status).toHaveText('Sorted by Name, ascending');

    const firstRow = page.locator('tbody tr').first();
    await expect(firstRow).toContainText('Ada Lovelace');

    // 5. Press Enter again
    await page.keyboard.press('Enter');

    // 6. Check descending state
    await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
    await expect(status).toHaveText('Sorted by Name, descending');
    await expect(firstRow).toContainText('Katherine Johnson');

    // 7-8. Activate Department button via keyboard and check single aria-sort migration
    const deptButton = page.getByRole('button', { name: 'Department' });
    await deptButton.focus();
    await page.keyboard.press('Enter');

    await expect(nameHeader).not.toHaveAttribute('aria-sort');
    await expect(page.locator('th[aria-sort]')).toHaveCount(1);

    // 9. Axe accessibility audit
    const axeResults = await new AxeBuilder({ page }).analyze();
    expect(axeResults.violations).toEqual([]);
  });

  test('broken variant - verifies keyboard/ARIA failures while functional sort works', async ({ page, baseURL }) => {
    // 1. Open broken variant
    const host = baseURL || 'http://localhost:5173';
    await page.goto(`${host}/#/dynamic/sortable-table?variant=broken`);

    // 2. Check missing accessible elements
    const nameButton = page.getByRole('button', { name: 'Name' });
    await expect(nameButton).toHaveCount(0);

    const caption = page.locator('caption');
    await expect(caption).toHaveCount(0);

    const status = page.getByRole('status');
    await expect(status).toHaveCount(0);

    // 3. Click with mouse to prove sorting functionality works
    const sortNameTrigger = page.getByTestId('sort-name');
    await sortNameTrigger.click();

    const firstRow = page.locator('tbody tr').first();
    await expect(firstRow).toContainText('Ada Lovelace');

    // 4-5. Check absence of aria-sort and verify Axe detects 0 violations (demonstrates tool limitations)
    const headersWithSort = page.locator('th[aria-sort]');
    await expect(headersWithSort).toHaveCount(0);

    const axeResults = await new AxeBuilder({ page }).analyze();
    expect(axeResults.violations).toEqual([]);
  });

});