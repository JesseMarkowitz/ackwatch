import { expect, test } from '@playwright/test';
import path from 'node:path';

const scenarios = [
  { name: 'signed-out-desktop', state: 'signed-out', viewport: { width: 1440, height: 1000 } },
  { name: 'ready-desktop', state: 'ready', viewport: { width: 1440, height: 1000 } },
  { name: 'armed-desktop', state: 'armed', viewport: { width: 1440, height: 1000 } },
  { name: 'signed-out-narrow', state: 'signed-out', viewport: { width: 390, height: 1100 } },
] as const;

for (const scenario of scenarios) {
  test(scenario.name, async ({ page }) => {
    await page.setViewportSize(scenario.viewport);
    await page.goto(`/?state=${scenario.state}`);
    await page.evaluate(() => document.fonts.ready);

    await expect(page.locator('html')).toHaveAttribute('data-catalog-state', scenario.state);
    await page.screenshot({
      animations: 'disabled',
      fullPage: true,
      path: path.join('artifacts', 'screenshots', `${scenario.name}.png`),
    });
  });
}
