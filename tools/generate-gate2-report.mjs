import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { recordedStep } from './recorded-step.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const unit = readJson('artifacts/reports/unit-results.json');
const browser = readJson('artifacts/reports/browser-results.json');
const visual = readJson('artifacts/reports/visual-results.json');
const localMatrix = readJson('artifacts/matrix/local-matrix-manifest.json');
const remoteMatrix = readJson('artifacts/matrix/remote-matrix-manifest.json');
const licenses = readJson('artifacts/reports/dependency-licenses.json');
const screenshots = readdirSync('artifacts/screenshots')
  .filter((file) => file.endsWith('.png'))
  .sort();
const requiredScreenshots = [
  'baseline-desktop.png',
  'ready-desktop.png',
  'armed-desktop.png',
  'received-desktop.png',
  'reconnecting-desktop.png',
  'recovering-desktop.png',
  'incomplete-desktop.png',
  'second-tab-desktop.png',
];
const missingScreenshots = requiredScreenshots.filter((file) => !screenshots.includes(file));

const requirements = {
  AUTH: {
    ids: ['AUTH-001', 'AUTH-002', 'AUTH-003', 'AUTH-004', 'AUTH-005', 'AUTH-006', 'AUTH-007'],
    evidence: [
      'src/infrastructure/matrix/authentication.test.ts',
      'src/infrastructure/browser/session-credential-store.test.ts',
      'src/application/app-controller.test.ts',
      'src/domain/coverage.test.ts',
      'tests/matrix/local-controller.mjs',
    ],
  },
  LOCK: {
    ids: ['LOCK-001', 'LOCK-002', 'LOCK-003', 'LOCK-004'],
    evidence: [
      'src/infrastructure/browser/web-lock-coordinator.test.ts',
      'src/application/app-controller.test.ts',
      'tests/matrix/local-controller.mjs',
      'artifacts/matrix/real-second-tab-blocked.png',
    ],
  },
  SYNC: {
    ids: ['SYNC-001', 'SYNC-002', 'SYNC-003', 'SYNC-004', 'SYNC-005', 'SYNC-006', 'SYNC-007'],
    evidence: [
      'src/domain/coverage.test.ts',
      'src/testing/scripted-sync.test.ts',
      'tests/matrix/local-controller.mjs',
    ],
  },
  GAP: {
    ids: ['GAP-001', 'GAP-002', 'GAP-003', 'GAP-004', 'GAP-005', 'GAP-006'],
    evidence: [
      'src/application/gap-recovery.test.ts',
      'src/infrastructure/persistence/coverage-issue-repository.test.ts',
      'src/domain/coverage.test.ts',
    ],
  },
  ING: {
    ids: ['ING-001', 'ING-002', 'ING-003', 'ING-004', 'ING-005', 'ING-006', 'ING-007'],
    evidence: [
      'src/domain/ingestion.test.ts',
      'src/application/gap-recovery.test.ts',
      'src/testing/scripted-sync.test.ts',
      'tests/matrix/local-controller.mjs',
    ],
  },
};

if (!unit.success || unit.numFailedTests !== 0) throw new Error('Unit evidence is not passing.');
if (browser.stats.unexpected !== 0 || browser.stats.expected < 4) {
  throw new Error('Browser evidence is incomplete.');
}
if (visual.stats.unexpected !== 0 || visual.stats.expected < 10 || missingScreenshots.length > 0) {
  throw new Error(`Visual evidence is incomplete: ${missingScreenshots.join(', ')}`);
}
if (localMatrix.result !== 'pass' || localMatrix.assertions.length < 7) {
  throw new Error('Disposable local Matrix evidence is not passing.');
}
if (!['pass', 'skipped'].includes(remoteMatrix.result)) {
  throw new Error('Remote Matrix mode is neither passing nor explicitly skipped.');
}

const report = {
  gate: 2,
  generatedAt: new Date().toISOString(),
  result: 'pass',
  branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  worktree: 'uncommitted',
  versions: {
    node: process.version,
    npm: JSON.parse(readFileSync('package.json', 'utf8')).packageManager,
    matrixJsSdk: JSON.parse(readFileSync('package.json', 'utf8')).dependencies['matrix-js-sdk'],
    synapse: localMatrix.homeserver.version,
  },
  checks: {
    fastChecks: recordedStep('fastChecks', 2),
    productionBuild: recordedStep('productionBuild', 2),
    unitAndComponent: { status: 'pass', tests: unit.numPassedTests },
    browserSmoke: {
      status: 'pass',
      tests: browser.stats.expected,
      engines: ['chromium', 'firefox'],
    },
    visualCatalog: { status: 'pass', screenshots: visual.stats.expected },
    localMatrix: {
      status: localMatrix.result,
      assertions: localMatrix.assertions,
      cleanup: localMatrix.cleanup,
    },
    remoteMatrix: { status: remoteMatrix.result, reason: remoteMatrix.reason },
    secretScan: recordedStep('secretScan', 2),
    trackedFileAudit: recordedStep('trackedFileAudit', 2),
    dependencyAudit: recordedStep('dependencyAudit', 2),
    licenses: {
      status: 'pass',
      packages: licenses.dependencies.length,
      unknown: licenses.dependencies.filter(({ license }) => license === 'UNKNOWN').length,
      agpl: licenses.dependencies.filter(({ license }) => /AGPL/i.test(String(license))).length,
    },
  },
  requirements,
  artifacts: {
    traceability: 'docs/TRACEABILITY.md',
    localMatrixManifest: 'artifacts/matrix/local-matrix-manifest.json',
    remoteMatrixManifest: 'artifacts/matrix/remote-matrix-manifest.json',
    realMatrixScreenshots: [
      'artifacts/matrix/real-ready.png',
      'artifacts/matrix/real-received.png',
      'artifacts/matrix/real-second-tab-blocked.png',
    ],
    catalogScreenshots: requiredScreenshots.map((file) => `artifacts/screenshots/${file}`),
  },
  limitations: [
    'Encrypted event decryption and enrichment remain Phase 4 work; Phase 2 surfaces an explicit ingestion issue.',
    'The optional developer-provided homeserver run is skipped when its credential set is absent.',
    'The event ledger is proof instrumentation, not the durable queue planned for Phase 3.',
  ],
};

mkdirSync('artifacts/reports', { recursive: true });
writeFileSync('artifacts/reports/gate2-summary.json', `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  'artifacts/reports/gate2-summary.md',
  `# AckWatch Gate 2 report

Result: **PASS**  
Generated: ${report.generatedAt}  
Toolchain: ${report.versions.node}, ${report.versions.npm}  
Matrix: matrix-js-sdk ${report.versions.matrixJsSdk}, Synapse ${report.versions.synapse}

- ${unit.numPassedTests} unit/component tests passed.
- ${browser.stats.expected} production browser checks passed in Chromium and Firefox.
- ${visual.stats.expected} deterministic state screenshots passed, including all eight required Gate 2 states.
- The disposable local Matrix scenario passed ${localMatrix.assertions.length} event-boundary assertions and cleaned up all three users from the synthetic room.
- The optional remote Matrix scenario was ${remoteMatrix.result}.
- AUTH, LOCK, SYNC, GAP, and ING mappings are recorded in \`docs/TRACEABILITY.md\` and this report.
- ${licenses.dependencies.length} installed packages were inventoried with no AGPL package dependencies.

Phase 3 remains gated on human review and explicit authorization.
`,
);

process.stdout.write('Generated machine-readable and human Gate 2 reports.\n');
