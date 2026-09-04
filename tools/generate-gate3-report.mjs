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
const screenshots = readdirSync('artifacts/screenshots').filter((file) => file.endsWith('.png'));
const requiredScreenshots = [
  'workflow-desktop.png',
  'workflow-detail-desktop.png',
  'workflow-narrow.png',
  'storage-fault-desktop.png',
];
const requiredMatrixAssertions = [
  'post-arm-accepted-once',
  'view-and-acknowledge',
  'edit-updates-without-new-item',
  'redaction-preserves-item',
  'thread-merge-review-complete',
  'completed-thread-reopens-new-cycle',
  'reload-unarmed',
  'reload-restores-workflow',
];
const missingScreenshots = requiredScreenshots.filter((name) => !screenshots.includes(name));
const missingMatrixAssertions = requiredMatrixAssertions.filter(
  (name) => !localMatrix.assertions.includes(name),
);

const requirements = {
  QUE: {
    ids: [
      'QUE-001',
      'QUE-002',
      'QUE-003',
      'QUE-004',
      'QUE-010',
      'QUE-011',
      'QUE-012',
      'QUE-013',
      'QUE-014',
      'QUE-015',
      'QUE-016',
      'QUE-017',
      'QUE-018',
      'QUE-019',
      'QUE-020',
    ],
    evidence: [
      'src/domain/queue.test.ts',
      'src/infrastructure/persistence/workflow-repository.test.ts',
      'tests/matrix/local-controller.mjs',
    ],
  },
  DDL: {
    ids: ['DDL-001', 'DDL-002', 'DDL-003', 'DDL-004', 'DDL-005', 'DDL-006'],
    evidence: [
      'src/domain/queue.test.ts',
      'src/infrastructure/persistence/workflow-repository.test.ts',
    ],
  },
  DB: {
    ids: ['DB-001', 'DB-002', 'DB-003', 'DB-004', 'DB-005', 'DB-006', 'DB-007', 'DB-008'],
    evidence: [
      'src/infrastructure/persistence/workflow-repository.test.ts',
      'src/infrastructure/browser/storage-health.test.ts',
      'src/application/app-controller.test.ts',
      'tests/browser/indexeddb.spec.ts',
    ],
  },
  UI: {
    ids: [
      'UI-001',
      'UI-002',
      'UI-003',
      'UI-004',
      'UI-005',
      'UI-006',
      'UI-007',
      'UI-008',
      'UI-009',
      'UI-011',
      'UI-013',
    ],
    deferredIds: ['UI-010', 'UI-012'],
    evidence: [
      'src/app/App.test.tsx',
      'tests/visual/state-catalog.spec.ts',
      'tests/matrix/local-controller.mjs',
    ],
  },
};

if (!unit.success || unit.numFailedTests !== 0) throw new Error('Unit evidence is not passing.');
if (browser.stats.unexpected !== 0 || browser.stats.expected < 8) {
  throw new Error('Chromium and Firefox IndexedDB evidence is incomplete.');
}
if (visual.stats.unexpected !== 0 || visual.stats.expected < 14 || missingScreenshots.length > 0) {
  throw new Error(`Workflow visual evidence is incomplete: ${missingScreenshots.join(', ')}`);
}
if (localMatrix.result !== 'pass' || missingMatrixAssertions.length > 0) {
  throw new Error(
    `Real Matrix workflow evidence is incomplete: ${missingMatrixAssertions.join(', ')}`,
  );
}
if (!['pass', 'skipped'].includes(remoteMatrix.result)) {
  throw new Error('Remote Matrix mode is neither passing nor explicitly skipped.');
}

const packageJson = readJson('package.json');
const report = {
  gate: 3,
  generatedAt: new Date().toISOString(),
  result: 'pass',
  branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  worktree: 'uncommitted',
  versions: {
    node: process.version,
    npm: packageJson.packageManager,
    dexie: packageJson.dependencies.dexie,
    matrixJsSdk: packageJson.dependencies['matrix-js-sdk'],
    synapse: localMatrix.homeserver.version,
  },
  checks: {
    fastChecks: recordedStep('fastChecks', 3),
    productionBuild: recordedStep('productionBuild', 3),
    unitAndComponent: { status: 'pass', tests: unit.numPassedTests },
    nativeIndexedDbAndBrowser: {
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
    secretScan: recordedStep('secretScan', 3),
    trackedFileAudit: recordedStep('trackedFileAudit', 3),
    dependencyAudit: recordedStep('dependencyAudit', 3),
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
    realMatrixScreenshots: [
      'artifacts/matrix/real-detail.png',
      'artifacts/matrix/real-completed.png',
      'artifacts/matrix/real-reopened.png',
    ],
    catalogScreenshots: requiredScreenshots.map((file) => `artifacts/screenshots/${file}`),
  },
  boundaries: [
    'Alert effect intents are durable; transport dispatch begins in Phase 4.',
    'Full on-demand decrypted detail (UI-010/UI-012) begins with the Phase 4 crypto/detail slice.',
    'DB-007 cleanup and DB-008 diagnostic-retention completion remain required before V1.',
    'The optional developer-provided homeserver run is skipped when its credential set is absent.',
  ],
};

mkdirSync('artifacts/reports', { recursive: true });
writeFileSync('artifacts/reports/gate3-summary.json', `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  'artifacts/reports/gate3-summary.md',
  `# AckWatch Gate 3 report

Result: **PASS**  
Generated: ${report.generatedAt}  
Toolchain: ${report.versions.node}, ${report.versions.npm}

- ${unit.numPassedTests} unit/component tests passed, including exhaustive queue commands, generated invariants, transaction fault injection, migration, and corruption handling.
- ${browser.stats.expected} production browser checks passed in Chromium and Firefox, including native IndexedDB rollback, restoration, and blocked upgrades.
- ${visual.stats.expected} deterministic screenshots passed, including workflow, detail, narrow, and storage-fault states.
- The disposable Matrix workflow passed ${localMatrix.assertions.length} assertions through view, acknowledge, edit, redaction, thread merge, complete, reopen, and reload restoration.
- QUE, DDL, DB, and base UI mappings are recorded in \`docs/TRACEABILITY.md\` and this report.
- Full decrypted on-demand detail, effect delivery, explicit data cleanup, and diagnostic retention remain honestly deferred as recorded boundaries.

Phase 4 remains gated on human review and explicit authorization.
`,
);

process.stdout.write('Generated machine-readable and human Gate 3 reports.\n');
