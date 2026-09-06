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
  // The settings route has never appeared in a baseline, though it has been rebuilt twice. It is
  // reached by hash, so the catalog gets there the same way an operator does.
  {
    name: 'settings-desktop',
    state: 'alerts-ready',
    viewport: { width: 1440, height: 1400 },
    hash: '#/settings',
  },
  {
    name: 'settings-narrow',
    state: 'alerts-ready',
    viewport: { width: 390, height: 1600 },
    hash: '#/settings',
  },
  // The detail dialog spends a lot of height on its header, which is affordable at 1440 and was
  // never checked anywhere else.
  {
    name: 'workflow-detail-narrow',
    state: 'workflow',
    viewport: { width: 390, height: 900 },
    openDetails: true,
  },
] as const;

for (const scenario of scenarios) {
  test(scenario.name, async ({ page }) => {
    await page.setViewportSize(scenario.viewport);
    await page.goto(`/?state=${scenario.state}${'hash' in scenario ? scenario.hash : ''}`);
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
