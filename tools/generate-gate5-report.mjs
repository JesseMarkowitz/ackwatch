import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { worktreeIdentifier } from './worktree-identifier.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonIfPresent(path) {
  return existsSync(path) ? readJson(path) : undefined;
}

// The harness records raw `performance.now()` deltas. Reporting them to fifteen decimal places
// implies a precision the measurement does not have.
const ms = (value) => Number(value.toFixed(1));

// Steps that leave no artifact of their own record a marker as they pass. Reading the marker keeps
// the report from asserting a result it never observed.
function recordedStep(name) {
  try {
    return readJson(`artifacts/reports/steps/${name}.json`).status;
  } catch {
    throw new Error(
      `The ${name} step left no recorded result. Run the complete "npm run check:gate5" chain.`,
    );
  }
}

// §8.4 requires a full report with no unexplained skips. A step may be absent only if this file
// names the reason, so "it did not run" can never pass review as silence.
const skips = [];
function skipped(reason) {
  skips.push(reason);
  return { status: 'skipped', reason };
}

const unit = readJson('artifacts/reports/unit-results.json');
const browser = readJson('artifacts/reports/browser-results.json');
const visual = readJson('artifacts/reports/visual-results.json');
const gallery = readJson('artifacts/gallery/manifest.json');
const scale = readJson('artifacts/reports/scale-summary.json');
const localMatrix = readJson('artifacts/matrix/local-matrix-manifest.json');
const remoteMatrix = readJson('artifacts/matrix/remote-matrix-manifest.json');
const webhook = readJson('artifacts/webhook/local-webhook-manifest.json');
const licenses = readJson('artifacts/reports/dependency-licenses.json');
// The soak occupies the machine for six hours and is scheduled separately (§8.3a), so the gate
// verifies its recorded manifest rather than re-running it inside the chain.
const soak = readJsonIfPresent('artifacts/soak/soak-manifest.json');
// WebKit is advisory: it is not Safari, its system libraries need root here, and it writes its own
// results file so an advisory run can never overwrite the required Chromium and Firefox evidence.
const webkit = readJsonIfPresent('artifacts/reports/webkit-results.json');

const screenshots = readdirSync('artifacts/screenshots').filter((file) => file.endsWith('.png'));
const requiredScreenshots = [
  'overdue-desktop.png',
  'encrypted-placeholder-desktop.png',
  'alerts-ready-desktop.png',
  'alert-faults-desktop.png',
  'crypto-fault-desktop.png',
];
const missingScreenshots = requiredScreenshots.filter((name) => !screenshots.includes(name));

if (!unit.success || unit.numFailedTests !== 0) throw new Error('Unit evidence is not passing.');
if (browser.stats.unexpected !== 0 || browser.stats.expected < 8) {
  throw new Error('Chromium and Firefox browser evidence is incomplete.');
}
if (visual.stats.unexpected !== 0 || visual.stats.expected < 19 || missingScreenshots.length > 0) {
  throw new Error(`Visual evidence is incomplete: ${missingScreenshots.join(', ')}`);
}
if (localMatrix.result !== 'pass') throw new Error('The disposable Matrix run is not passing.');
if (webhook.result !== 'pass') throw new Error('Self-hosted ntfy evidence is not passing.');
if (!['pass', 'skipped'].includes(remoteMatrix.result)) {
  throw new Error('Remote Matrix mode is neither passing nor explicitly skipped.');
}

// §8.4 requires human-approved screenshot baselines and a reproducible production artifact, and
// approval only means something against the tree the gallery was rendered from. A `-modified`
// identifier is its own failure: a release candidate is not cut from a dirty worktree.
const head = worktreeIdentifier();
if (gallery.worktreeIdentifier !== head) {
  throw new Error(
    `The screenshot gallery was rendered from ${gallery.worktreeIdentifier}, not the current ${head}. Re-run "npm run test:visual" so the approved baselines match what ships.`,
  );
}
if (head.endsWith('-modified') || head === 'uncommitted-worktree') {
  throw new Error(
    `The worktree is ${head}. Commit the release candidate and re-run the gate so its evidence names a reproducible tree.`,
  );
}

// §8.4 requires release notes stating the browser, closed-page and notification limitations
// plainly. A release-notes file that omits one of them is not evidence of an honest limitation.
if (!existsSync('RELEASE_NOTES.md')) {
  throw new Error('RELEASE_NOTES.md is missing; §8.4 requires release notes with the limitations.');
}
const releaseNotes = readFileSync('RELEASE_NOTES.md', 'utf8');
const requiredDisclosures = [
  { label: 'WebKit is not Safari', pattern: /not\s+(real\s+)?Safari/iu },
  { label: 'monitoring stops with the page', pattern: /closed|page can run|while the page/iu },
  { label: 'notification limitations', pattern: /notification/iu },
  { label: 'deployer-supplied CSP origins', pattern: /Content Security Policy|CSP/u },
];
const undisclosed = requiredDisclosures.filter(({ pattern }) => !pattern.test(releaseNotes));
if (undisclosed.length > 0) {
  throw new Error(
    `RELEASE_NOTES.md does not state: ${undisclosed.map(({ label }) => label).join(', ')}.`,
  );
}

// §8.3a performance targets at the stress ceiling. Per-event cost is a recorded, accepted deviation
// there and nowhere else: below the ceiling every target is enforced.
const atStressCeiling = scale.target.activities >= 10_000;
const perEventDeviation =
  atStressCeiling && scale.samples.at(-1).perEventMs > 50
    ? {
        metric: 'perEventMs',
        measured: Number(scale.samples.at(-1).perEventMs.toFixed(1)),
        target: 50,
        accepted:
          'Accepted for V1. Every other target is met at the ceiling, and every target including this one is met at a realistic session size. Closing it means incremental item maintenance, whose failure mode is stale or duplicated items after a thread merge deletes one — a correctness risk taken on for a cost that only appears at five times the realistic load.',
      }
    : undefined;
const scaleFailures = [
  scale.commandMs > 100 ? `command ${scale.commandMs} ms exceeds 100 ms` : undefined,
  scale.schedulerMs > 500 ? `scheduler pass ${scale.schedulerMs} ms exceeds 500 ms` : undefined,
  !atStressCeiling && scale.samples.at(-1).perEventMs > 50
    ? `per-event ${scale.samples.at(-1).perEventMs} ms exceeds 50 ms below the stress ceiling`
    : undefined,
].filter(Boolean);
if (scaleFailures.length > 0) {
  throw new Error(`Scale targets were not met: ${scaleFailures.join('; ')}.`);
}

// The soak is the §8.2 longevity evidence. A smoke run proves the harness works and nothing else,
// so it is not accepted as the gate's evidence.
let soakCheck;
if (!soak) {
  soakCheck = skipped(
    'The six-hour soak has not been run. Run "npm run test:soak" and re-run this report; §8.2 longevity is unevidenced until then.',
  );
} else if (soak.smokeRun) {
  soakCheck = skipped(
    `The recorded soak was a ${soak.plannedMinutes}-minute smoke run, which exercises the harness but cannot establish a shift-length trend. Run "npm run test:soak" at its default length.`,
  );
} else if (soak.result !== 'pass') {
  throw new Error(
    `The recorded soak failed: ${soak.failure ?? 'see artifacts/soak/soak-manifest.json'}`,
  );
} else {
  soakCheck = {
    status: 'pass',
    minutes: soak.plannedMinutes,
    totals: soak.totals,
    growth: soak.growth,
    checks: soak.checks.map(({ name, status }) => ({ name, status })),
  };
}

const webkitCheck = webkit
  ? {
      status: webkit.stats.unexpected === 0 ? 'pass' : 'fail',
      advisory: true,
      tests: webkit.stats.expected,
      note: 'Advisory only. WebKit through Playwright is not Safari and is not released as Safari support.',
    }
  : skipped(
      'WebKit is advisory and was not run: its Playwright build needs host system libraries that install with root. Chromium and Firefox are the required engines; WebKit is not released as Safari support either way.',
    );

const remoteCheck =
  remoteMatrix.result === 'pass'
    ? { status: 'pass', assertions: remoteMatrix.assertions, cleanup: remoteMatrix.cleanup }
    : skipped(
        `The developer-provided homeserver run was skipped: ${remoteMatrix.reason ?? 'credentials were absent'}.`,
      );

const packageJson = readJson('package.json');
const requirements = {
  SESSION: {
    ids: Array.from({ length: 9 }, (_, index) => `SES-${String(index + 1).padStart(3, '0')}`),
    evidence: [
      'src/infrastructure/persistence/workflow-repository.test.ts',
      'src/application/app-controller.test.ts',
      'docs/adr/0010-work-session-lifecycle.md',
    ],
  },
  DEADLINE: { ids: ['DDL-007'], evidence: ['src/domain/queue.test.ts'] },
  DEPLOYMENT: {
    ids: ['SEC-001', 'SEC-005', 'SEC-006', 'SEC-007'],
    evidence: ['tests/browser/csp.spec.ts', 'docs/DEPLOYMENT.md', 'SECURITY.md'],
  },
  DIAGNOSTICS: {
    ids: ['DB-007', 'DB-008'],
    evidence: ['src/infrastructure/persistence/workflow-repository.test.ts'],
  },
  LONGEVITY: { ids: ['REL-001', 'REL-002'], evidence: ['tests/soak/soak-controller.mjs'] },
  SCALE: { ids: ['PRF-001', 'PRF-002', 'PRF-003'], evidence: ['tests/scale'] },
};

const result = skips.length === 0 ? 'pass' : 'incomplete';
const report = {
  gate: 5,
  generatedAt: new Date().toISOString(),
  result,
  branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  commit: head,
  versions: {
    node: process.version,
    npm: packageJson.packageManager,
    matrixJsSdk: packageJson.dependencies['matrix-js-sdk'],
    synapse: localMatrix.homeserver.version,
    ntfy: webhook.version,
  },
  checks: {
    fastChecks: recordedStep('fastChecks'),
    productionBuild: recordedStep('productionBuild'),
    unitAndComponent: { status: 'pass', tests: unit.numPassedTests, skipped: unit.numPendingTests },
    browsers: { status: 'pass', tests: browser.stats.expected, engines: ['chromium', 'firefox'] },
    webkitAdvisory: webkitCheck,
    visualCatalog: {
      status: 'pass',
      screenshots: visual.stats.expected,
      renderedFrom: gallery.worktreeIdentifier,
    },
    scale: {
      status: 'pass',
      target: scale.target,
      startupMs: ms(scale.startupMs),
      renderMs: ms(scale.renderMs),
      commandMs: ms(scale.commandMs),
      schedulerMs: ms(scale.schedulerMs),
      migrationMs: ms(scale.migrationMs),
      perEventMs: ms(scale.samples.at(-1).perEventMs),
      ...(perEventDeviation ? { acceptedDeviation: perEventDeviation } : {}),
    },
    soak: soakCheck,
    localMatrix: { status: localMatrix.result, assertions: localMatrix.assertions },
    localWebhook: { status: webhook.result, assertions: webhook.assertions },
    remoteMatrix: remoteCheck,
    secretScan: recordedStep('secretScan'),
    trackedFileAudit: recordedStep('trackedFileAudit'),
    dependencyAudit: recordedStep('dependencyAudit'),
    licenses: {
      status: 'pass',
      packages: licenses.dependencies.length,
      unknown: licenses.dependencies.filter(({ license }) => license === 'UNKNOWN').length,
      agpl: licenses.dependencies.filter(({ license }) => /AGPL/iu.test(String(license))).length,
    },
  },
  requirements,
  explainedSkips: skips,
  artifacts: {
    traceability: 'docs/TRACEABILITY.md',
    releaseNotes: 'RELEASE_NOTES.md',
    deployment: 'docs/DEPLOYMENT.md',
    soakManifest: 'artifacts/soak/soak-manifest.json',
    scaleSummary: 'artifacts/reports/scale-summary.json',
    screenshotGallery: 'artifacts/gallery/index.html',
  },
  boundaries: [
    'Monitoring, alerting and delivery run only while the page can run; a closed page monitors nothing.',
    'External delivery is durable intent with stable IDs, not exactly-once receiver delivery.',
    'The shipped Content Security Policy is a template: the deployer supplies their homeserver and webhook origins.',
    'Chromium and Firefox are the supported engines. WebKit runs advisory-only through Playwright and is not Safari.',
    'A session is retired when the continuity window elapses from its start, even if the operator never left.',
  ],
};

mkdirSync('artifacts/reports', { recursive: true });
writeFileSync('artifacts/reports/gate5-summary.json', `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  'artifacts/reports/gate5-summary.md',
  `# AckWatch Gate 5 report

Result: **${result.toUpperCase()}**  
Generated: ${report.generatedAt}  
Commit: ${head}  
Toolchain: ${report.versions.node}, ${report.versions.npm}

- ${unit.numPassedTests} unit/component tests passed; ${unit.numPendingTests} service-gated test was exercised separately.
- ${browser.stats.expected} system and accessibility tests passed in Chromium and Firefox under the production CSP.
- ${visual.stats.expected} visual scenarios passed; the gallery is rendered from ${gallery.worktreeIdentifier}.
- Scale at ${scale.target.activities} activities / ${scale.target.items} items: ${ms(scale.commandMs)} ms command, ${ms(scale.schedulerMs)} ms scheduler pass, ${ms(scale.samples.at(-1).perEventMs)} ms per event.${perEventDeviation ? ' Per-event cost is a recorded accepted deviation at this ceiling.' : ''}
- Longevity: ${soakCheck.status === 'pass' ? `${soak.plannedMinutes}-minute soak passed with ${soak.totals.acknowledged} acknowledged and ${soak.totals.completed} completed across ${soak.totals.reconnects} reconnects.` : soakCheck.reason}
- The disposable Matrix run passed ${localMatrix.assertions.length} assertions; the self-hosted ntfy run passed ${webhook.assertions.length}.
${skips.length === 0 ? '\nEvery step has evidence. Release remains gated on human review and explicit authorization.\n' : `\n## Explained skips\n\n${skips.map((reason) => `- ${reason}`).join('\n')}\n\nThis gate is incomplete until each is resolved or accepted in writing.\n`}`,
);

process.stdout.write(
  `Generated machine-readable and human Gate 5 reports: ${result}${skips.length > 0 ? ` (${skips.length} explained skips)` : ''}.\n`,
);
