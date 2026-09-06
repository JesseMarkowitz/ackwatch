import { expect, test } from '@playwright/test';

/**
 * Asserts the page never scrolls sideways.
 *
 * This class of defect hid for weeks because the evidence looked normal: a screenshot of an
 * overflowing page is simply a wider image, and a gallery shows the image rather than the
 * discrepancy between it and the viewport it was taken at. Three separate overflows were found by
 * measuring rather than looking — a top bar that would not wrap, a health strip demanding 48rem,
 * and a status pill wider than its own grid track.
 *
 * The widths are chosen where layout actually changes: either side of the 800px breakpoint, the
 * band most laptops sit in, and the narrowest the application claims to support.
 */
const widths = [1440, 1100, 1024, 900, 820, 800, 700, 500, 390, 320];

const states = [
  'workflow',
  'incomplete',
  'alert-faults',
  'storage-fault',
  'overdue',
  'signed-out',
] as const;

for (const state of states) {
  test(`${state} never scrolls sideways`, async ({ page }) => {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?state=${state}`);
      await expect(page.locator('html')).toHaveAttribute('data-catalog-state', state);

      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth, `${state} overflows its ${width}px viewport`).toBeLessThanOrEqual(width);
    }
  });
}

/**
 * A card must stay inside the column that holds it.
 *
 * The page-level check above does not catch this: a card can be wider than its column while the
 * page still fits the window, and it simply paints over the column's border. It happened with a
 * room that had no name, so the card fell back to the room id — long, and with nothing to break
 * at — which no fixture had until one was added for this.
 */
test('queue cards stay inside their columns', async ({ page }) => {
  for (const width of [1440, 1100, 900, 700, 390]) {
    await page.setViewportSize({ width, height: 1400 });
    await page.goto('/?state=workflow');
    await expect(page.locator('.queue-column').first()).toBeVisible();

    const spills = await page.evaluate(() =>
      [...document.querySelectorAll('.queue-column')].flatMap((column) => {
        const bounds = column.getBoundingClientRect();
        return [...column.querySelectorAll('.queue-card')]
          .map((card) => card.getBoundingClientRect())
          .filter((card) => card.right > bounds.right + 0.5 || card.left < bounds.left - 0.5)
          .map((card) => Math.round(card.right - bounds.right));
      }),
    );

    expect(spills, `a card escapes its column at ${width}px`).toEqual([]);
  }
});
