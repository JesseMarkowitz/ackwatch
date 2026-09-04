import { readFileSync } from 'node:fs';

/**
 * Reads the marker a release-chain step writes as it passes.
 *
 * Steps like formatting, the production build, and the audits leave no artifact of their own, so a
 * report has nothing to inspect afterwards. Gates 1-3 originally wrote `'pass'` as a string literal
 * for each of them: the report asserted results it had never observed, and would emit a complete
 * PASS when run on its own. The literals also froze — Gate 1 reported three unit tests long after
 * the suite passed a hundred.
 *
 * The chain records a marker only after the step exits zero, so reading it is evidence. Throwing on
 * a missing marker is the point: a report must not be producible from a partial run.
 */
export function recordedStep(name, gate) {
  try {
    return JSON.parse(readFileSync(`artifacts/reports/steps/${name}.json`, 'utf8')).status;
  } catch {
    throw new Error(
      `The ${name} step left no recorded result. Run the complete "npm run check:gate${gate}" chain.`,
    );
  }
}
