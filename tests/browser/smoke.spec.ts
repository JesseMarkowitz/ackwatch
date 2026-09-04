import { expect, test } from '@playwright/test';

for (const mountPath of ['/', '/ackwatch/']) {
  test(`production shell loads from ${mountPath}`, async ({ page }) => {
    await page.goto(mountPath);

    await expect(page).toHaveTitle('AckWatch');
    // Anchored on the sign-in field rather than marketing copy: it proves React mounted and
    // rendered interactive UI, and it does not have to be revisited every time wording changes.
    await expect(page.getByLabel(/matrix user id/i)).toBeVisible();
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
