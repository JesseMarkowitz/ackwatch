import { expect, test } from '@playwright/test';

for (const mountPath of ['/', '/ackwatch/']) {
  test(`production shell loads from ${mountPath}`, async ({ page }) => {
    await page.goto(mountPath);

    await expect(page).toHaveTitle('AckWatch');
    await expect(page.getByRole('heading', { name: /important messages/i })).toBeVisible();
    await expect(page.getByLabel('Monitoring health')).toContainText('Signed out');

    const resourceFailures = await page.locator('body').evaluate(() =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => (entry as PerformanceResourceTiming).responseStatus >= 400)
        .map((entry) => entry.name),
    );
    expect(resourceFailures).toEqual([]);
  });
}
