import { expect, test } from '@playwright/test';

/**
 * Qualifies installability, which is otherwise invisible: a blocked or mistyped manifest produces
 * no error on the page and no failing request the operator would notice — the install option
 * simply never appears. The CSP that ships in docs/DEPLOYMENT.md denies `default-src`, so the
 * manifest needs its own directive; this asserts the policy actually admits it.
 */
test('the application is installable under the documented policy', async ({ page, request }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __manifestViolations: string[] }).__manifestViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      if (event.violatedDirective.startsWith('manifest')) {
        (window as unknown as { __manifestViolations: string[] }).__manifestViolations.push(
          event.blockedURI,
        );
      }
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && /manifest/i.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', './manifest.json');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);

  const response = await request.get('/manifest.json');
  expect(response.status()).toBe(200);
  // A manifest served as octet-stream is ignored by the browser, which is why the file is not
  // named .webmanifest: several static servers have no MIME entry for that extension.
  expect(response.headers()['content-type']).toContain('json');

  const manifest: unknown = await response.json();
  expect(manifest).toMatchObject({
    name: 'AckWatch',
    start_url: './',
    display: 'standalone',
  });

  // Every declared icon must exist: a manifest referencing a missing icon is treated as
  // uninstallable, and the maskable one is what keeps the mark from being cropped on Android.
  const icons = (manifest as { icons: readonly { src: string; purpose: string }[] }).icons;
  expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  for (const icon of icons) {
    const iconResponse = await request.get(`/${icon.src.replace('./', '')}`);
    expect(iconResponse.status(), `${icon.src} is missing`).toBe(200);
    expect(iconResponse.headers()['content-type']).toContain('image/png');
  }

  expect(
    await page.evaluate(
      () => (window as unknown as { __manifestViolations: string[] }).__manifestViolations,
    ),
  ).toEqual([]);
  expect(violations).toEqual([]);
});
