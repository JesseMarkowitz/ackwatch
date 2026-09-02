import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

// Records that a release-chain step completed. Because the gate commands chain with `&&`, this
// only runs when the preceding step exited zero, so the marker is evidence rather than a claim.
// `--reset` clears markers at the head of a chain so a later report can never read a stale one.

const directory = 'artifacts/reports/steps';
const [name] = process.argv.slice(2);

if (!name) throw new Error('Provide a step name to record, or --reset.');

if (name === '--reset') {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  // The generated summaries are removed with the markers. A gate report left on disk from an
  // earlier run reads as current to anyone inspecting it after a failed chain, which is how a
  // stale "pass" gets believed; the file may only exist when this chain reaches its end.
  for (const stale of ['gate4-summary.json', 'gate4-summary.md']) {
    rmSync(`artifacts/reports/${stale}`, { force: true });
  }
  process.stdout.write('Cleared recorded release-chain steps and stale gate summaries.\n');
} else {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${directory}/${name}.json`,
    `${JSON.stringify({ step: name, status: 'pass', at: new Date().toISOString() }, null, 2)}\n`,
  );
  process.stdout.write(`Recorded release-chain step ${name}.\n`);
}
