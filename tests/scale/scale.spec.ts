import { mkdirSync, writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { PhaseSample, ScaleProgress } from '../../src/testing/benchmark/scale-benchmark';

/**
 * Phase 5 §8.2 scale measurement. The numbers are the deliverable, so this records the growth curve
 * rather than asserting a fixed duration. Checkpoints are collected as they land: an overrunning
 * run still publishes everything it reached, because a measurement that yields nothing on timeout
 * teaches nothing.
 */

// A geometric ladder separates linear from quadratic growth far better than equal steps, and the
// early points arrive within seconds.
const ladder = (process.env.ACKWATCH_SCALE_LADDER ?? '250,500,1000,2000,4000,8000,10000')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isSafeInteger(value) && value > 0);
const targetItems = Number.parseInt(process.env.ACKWATCH_SCALE_ITEMS ?? '1000', 10);

function formatSample(sample: PhaseSample): string {
  return (
    `  ${String(sample.activities).padStart(6)} activities / ${String(sample.items).padStart(5)} items  ` +
    `projection ${sample.projectionMs.toFixed(1).padStart(9)}ms  ` +
    `per-event ${sample.perEventMs.toFixed(1).padStart(9)}ms  ` +
    `accept ${sample.acceptMs.toFixed(2).padStart(7)}ms  ` +
    `transitions ${sample.transitions}`
  );
}

test('measures workflow behaviour as the store grows', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  await page.goto('/');
  await page.waitForFunction(
    () => document.documentElement.dataset.scaleBenchmark === 'ready',
    undefined,
    { timeout: 30_000 },
  );

  await page.evaluate(
    ([points, items]) => {
      const benchmark = window.__ackwatchScale;
      if (!benchmark) throw new Error('The scale benchmark harness was not installed.');
      benchmark.start(points as number[], items as number);
    },
    [ladder, targetItems] as const,
  );

  mkdirSync('artifacts/reports', { recursive: true });
  const writeSummary = (state: ScaleProgress) =>
    writeFileSync(
      'artifacts/reports/scale-summary.json',
      `${JSON.stringify(
        state.report ?? {
          generatedAt: new Date().toISOString(),
          incomplete: true,
          reachedPhase: state.phase,
          samples: state.samples,
          ...(state.error === undefined ? {} : { error: state.error }),
        },
        null,
        2,
      )}\n`,
    );

  const deadline = Date.now() + 780_000;
  let progress: ScaleProgress = { phase: 'starting', done: false, samples: [] };
  let reported = 0;

  while (Date.now() < deadline) {
    progress = (await page.evaluate(() => window.__ackwatchScale?.progress())) as ScaleProgress;
    for (const sample of progress.samples.slice(reported)) {
      process.stdout.write(`${formatSample(sample)}\n`);
    }
    reported = progress.samples.length;
    // Written every poll so a run that overruns its budget is still observable from outside.
    writeSummary(progress);
    if (progress.done) break;
    await page.waitForTimeout(2_000);
  }

  if (progress.report) {
    const timings = (await page.evaluate(
      async (name) => await window.__ackwatchScale?.profileProjection(name as string),
      progress.report.databaseName,
    )) as Record<string, number> | undefined;
    if (timings) {
      process.stdout.write(`\n  projection breakdown at full size:\n`);
      for (const [key, value] of Object.entries(timings)) {
        process.stdout.write(`    ${key.padEnd(28)} ${value.toFixed(1)}\n`);
      }
    }
  }

  writeSummary(progress);

  const first = progress.samples[0];
  const last = progress.samples.at(-1);
  if (first && last && last !== first) {
    process.stdout.write(
      `\n  projection grew ${(last.projectionMs / Math.max(first.projectionMs, 0.001)).toFixed(1)}x ` +
        `for ${(last.activities / Math.max(first.activities, 1)).toFixed(1)}x the activities\n`,
    );
  }
  if (progress.report) {
    const report = progress.report;
    process.stdout.write(
      `  scheduler samples: ${report.schedulerSamples.map((v) => v.toFixed(0)).join(', ')}ms\n` +
        `  command samples: ${report.commandSamples.map((v) => v.toFixed(0)).join(', ')}ms\n` +
        `  startup ${report.startupMs.toFixed(1)}ms  render ${report.renderMs.toFixed(1)}ms  ` +
        `command ${report.commandMs.toFixed(1)}ms  scheduler ${report.schedulerMs.toFixed(1)}ms  ` +
        `migration ${report.migrationMs.toFixed(1)}ms\n`,
    );
  }

  expect(progress.error, `benchmark error: ${progress.error ?? ''}`).toBeUndefined();
  expect(failures, `browser errors during the scale run: ${failures.join(' | ')}`).toEqual([]);
  expect(progress.samples.length, 'the benchmark produced no checkpoints').toBeGreaterThan(0);
  expect(progress.done, 'the benchmark did not finish within its budget').toBe(true);
});
