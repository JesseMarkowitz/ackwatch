import { expect, test } from '@playwright/test';
import path from 'node:path';

const scenarios = [
  { name: 'signed-out-desktop', state: 'signed-out', viewport: { width: 1440, height: 1000 } },
  { name: 'ready-desktop', state: 'ready', viewport: { width: 1440, height: 1000 } },
  { name: 'armed-desktop', state: 'armed', viewport: { width: 1440, height: 1000 } },
  { name: 'baseline-desktop', state: 'baseline', viewport: { width: 1440, height: 1000 } },
  { name: 'received-desktop', state: 'received', viewport: { width: 1440, height: 1120 } },
  { name: 'reconnecting-desktop', state: 'reconnecting', viewport: { width: 1440, height: 1000 } },
  { name: 'recovering-desktop', state: 'recovering', viewport: { width: 1440, height: 1000 } },
  { name: 'incomplete-desktop', state: 'incomplete', viewport: { width: 1440, height: 1000 } },
  { name: 'second-tab-desktop', state: 'second-tab', viewport: { width: 1440, height: 1000 } },
  { name: 'workflow-desktop', state: 'workflow', viewport: { width: 1440, height: 1200 } },
  { name: 'overdue-desktop', state: 'overdue', viewport: { width: 1440, height: 1200 } },
  {
    name: 'encrypted-placeholder-desktop',
    state: 'encrypted-placeholder',
    viewport: { width: 1440, height: 1200 },
  },
  {
    name: 'alerts-ready-desktop',
    state: 'alerts-ready',
    viewport: { width: 1440, height: 1300 },
  },
  {
    name: 'alert-faults-desktop',
    state: 'alert-faults',
    viewport: { width: 1440, height: 1300 },
  },
  {
    name: 'crypto-fault-desktop',
    state: 'crypto-fault',
    viewport: { width: 1440, height: 1200 },
  },
  {
    name: 'workflow-detail-desktop',
    state: 'workflow',
    viewport: { width: 1440, height: 1100 },
    openDetails: true,
  },
  {
    name: 'storage-fault-desktop',
    state: 'storage-fault',
    viewport: { width: 1440, height: 1000 },
  },
  {
    name: 'session-interrupted-desktop',
    state: 'session-interrupted',
    viewport: { width: 1440, height: 1200 },
  },
  {
    name: 'session-archived-desktop',
    state: 'session-archived',
    viewport: { width: 1440, height: 1200 },
  },
  { name: 'signed-out-narrow', state: 'signed-out', viewport: { width: 390, height: 1100 } },
  { name: 'workflow-narrow', state: 'workflow', viewport: { width: 390, height: 1400 } },
] as const;

for (const scenario of scenarios) {
  test(scenario.name, async ({ page }) => {
    await page.setViewportSize(scenario.viewport);
    await page.goto(`/?state=${scenario.state}`);
    await page.evaluate(() => document.fonts.ready);

    await expect(page.locator('html')).toHaveAttribute('data-catalog-state', scenario.state);
    if ('openDetails' in scenario && scenario.openDetails) {
      await page.getByRole('button', { name: 'View details' }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
    }
    await page.screenshot({
      animations: 'disabled',
      fullPage: true,
      path: path.join('artifacts', 'screenshots', `${scenario.name}.png`),
    });
  });
}
