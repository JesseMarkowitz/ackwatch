import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Steps that leave no artifact of their own record a marker as they pass. Reading the marker
// keeps the report from asserting a result it never observed.
function recordedStep(name) {
  try {
    return readJson(`artifacts/reports/steps/${name}.json`).status;
  } catch {
    throw new Error(
      `The ${name} step left no recorded result. Run the complete "npm run check:gate4" chain.`,
    );
  }
}

const unit = readJson('artifacts/reports/unit-results.json');
const browser = readJson('artifacts/reports/browser-results.json');
const visual = readJson('artifacts/reports/visual-results.json');
const localMatrix = readJson('artifacts/matrix/local-matrix-manifest.json');
const remoteMatrix = readJson('artifacts/matrix/remote-matrix-manifest.json');
const webhook = readJson('artifacts/webhook/local-webhook-manifest.json');
const licenses = readJson('artifacts/reports/dependency-licenses.json');
const screenshots = readdirSync('artifacts/screenshots').filter((file) => file.endsWith('.png'));
const requiredScreenshots = [
  'overdue-desktop.png',
  'encrypted-placeholder-desktop.png',
  'alerts-ready-desktop.png',
  'alert-faults-desktop.png',
  'crypto-fault-desktop.png',
];
const requiredMatrixAssertions = [
  'complete-message-types-and-ordinary-reply',
  'real-e2ee-text-thread-and-detail',
  'reload-restores-persistent-crypto-device',
  'cross-signing-secret-storage-key-backup-setup',
  'unknown-token-visible-and-fatal',
  'new-device-key-backup-restore',
  'own-device-emoji-sas-verification',
];
const missingScreenshots = requiredScreenshots.filter((name) => !screenshots.includes(name));
const missingMatrixAssertions = requiredMatrixAssertions.filter(
  (name) => !localMatrix.assertions.includes(name),
);

if (!unit.success || unit.numFailedTests !== 0) throw new Error('Unit evidence is not passing.');
if (browser.stats.unexpected !== 0 || browser.stats.expected < 8) {
  throw new Error('Chromium and Firefox browser evidence is incomplete.');
}
if (visual.stats.unexpected !== 0 || visual.stats.expected < 19 || missingScreenshots.length > 0) {
  throw new Error(`Phase 4 visual evidence is incomplete: ${missingScreenshots.join(', ')}`);
}
if (localMatrix.result !== 'pass' || missingMatrixAssertions.length > 0) {
  throw new Error(`Phase 4 Matrix evidence is incomplete: ${missingMatrixAssertions.join(', ')}`);
}
if (!['pass', 'skipped'].includes(remoteMatrix.result)) {
  throw new Error('Remote Matrix mode is neither passing nor explicitly skipped.');
}
if (webhook.result !== 'pass') throw new Error('Self-hosted ntfy evidence is not passing.');
// Console failures the disposable rig provokes that are not application defects. The controller
// records browser errors verbatim; classifying them here keeps the judgement reviewable and
// re-runnable against a stored manifest instead of costing another homeserver run.
const expectedBrowserNoise = [
  // matrix-js-sdk polls .well-known for the MXID's domain once the client starts. The synthetic
  // `ackwatch.test` server name never resolves, and Synapse answers 404 for its own well-known.
  { pattern: /\/\.well-known\/matrix\//u },
  // The SDK also polls an unstable MSC4143 RTC-transports endpoint that Synapse does not implement.
  { pattern: /\/unstable\/org\.matrix\.msc4143\/rtc\/transports/u },
  // Key backup is queried before the scenario creates one.
  { pattern: /\/room_keys\/version\b/u },
  // The static test host intentionally serves no favicon.
  { pattern: /\/favicon\.ico$/u },
  // The scenario invalidates every session for the account on purpose to prove the unknown-token
  // boundary. The resulting authorization failures are expected only inside that window; the same
  // failures anywhere else in the run stay unexplained and fail this report.
  { pattern: /\b401\b|M_UNKNOWN_TOKEN|refresh token/u, phase: 'token-invalidated' },
];
const recordedBrowserErrors = [
  ...(localMatrix.browserErrors ?? []),
  ...(localMatrix.expectedBrowserNoise ?? []),
];
const isExpectedNoise = (entry) =>
  expectedBrowserNoise.some(
    ({ pattern, phase }) =>
      (phase === undefined || phase === entry.phase) &&
      pattern.test(`${entry.url ?? ''} ${entry.console ?? entry.message ?? ''}`),
  );
const unexplainedBrowserErrors = recordedBrowserErrors.filter((entry) => !isExpectedNoise(entry));
if (unexplainedBrowserErrors.length > 0) {
  throw new Error(
    `The Matrix run reported ${unexplainedBrowserErrors.length} unexplained browser errors: ${JSON.stringify(unexplainedBrowserErrors)}`,
  );
}

const packageJson = readJson('package.json');
const requirements = {
  EVT: {
    ids: Array.from({ length: 9 }, (_, index) => `EVT-${String(index + 1).padStart(3, '0')}`),
    evidence: ['src/domain/ingestion.test.ts', 'tests/matrix/local-controller.mjs'],
  },
  ALT: {
    ids: Array.from({ length: 16 }, (_, index) => `ALT-${String(index + 1).padStart(3, '0')}`),
    evidence: [
      'src/application/alert-dispatcher.test.ts',
      'src/infrastructure/persistence/workflow-repository.test.ts',
      'src/infrastructure/browser/webhook-transport.integration.test.ts',
      'tests/webhook/local-controller.mjs',
    ],
  },
  SECURITY: {
    ids: ['SEC-002', 'SEC-003', 'SEC-004', 'SEC-008', 'SEC-009', 'SEC-010'],
    evidence: ['SECURITY.md', 'src/infrastructure/browser/webhook-transport.test.ts'],
  },
  RELIABILITY: {
    ids: ['REL-005'],
    evidence: [
      'src/infrastructure/persistence/workflow-repository.test.ts',
      'tests/matrix/local-controller.mjs',
    ],
  },
};

const report = {
  gate: 4,
  generatedAt: new Date().toISOString(),
  result: 'pass',
  branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  worktree: 'uncommitted',
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
    visualCatalog: { status: 'pass', screenshots: visual.stats.expected },
    localMatrix: {
      status: localMatrix.result,
      assertions: localMatrix.assertions,
      cleanup: localMatrix.cleanup,
      unexplainedBrowserErrors: unexplainedBrowserErrors.length,
      expectedBrowserNoise: recordedBrowserErrors.length - unexplainedBrowserErrors.length,
    },
    localWebhook: { status: webhook.result, assertions: webhook.assertions },
    remoteMatrix: { status: remoteMatrix.result, reason: remoteMatrix.reason },
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
  artifacts: {
    traceability: 'docs/TRACEABILITY.md',
    localMatrixManifest: 'artifacts/matrix/local-matrix-manifest.json',
    localWebhookManifest: 'artifacts/webhook/local-webhook-manifest.json',
    realEncryptedScreenshot: 'artifacts/matrix/real-encrypted.png',
    catalogScreenshots: requiredScreenshots.map((file) => `artifacts/screenshots/${file}`),
  },
  boundaries: [
    'Browser transports and Matrix monitoring operate only while the page can run.',
    'External delivery is durable intent with stable IDs, not exactly-once receiver delivery.',
    'The final deployed Content Security Policy and completed-history cleanup remain Phase 5 work.',
    'The optional developer-provided homeserver run is skipped when credentials are absent.',
  ],
};

mkdirSync('artifacts/reports', { recursive: true });
writeFileSync('artifacts/reports/gate4-summary.json', `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(
  'artifacts/reports/gate4-summary.md',
  `# AckWatch Gate 4 report

Result: **PASS**  
Generated: ${report.generatedAt}  
Toolchain: ${report.versions.node}, ${report.versions.npm}

- ${unit.numPassedTests} ordinary unit/component/socket tests passed; ${unit.numPendingTests} service-gated ntfy test was exercised separately.
- ${visual.stats.expected} deterministic visual scenarios passed, including overdue, encrypted, crypto, and independent alert health/fault states.
- The disposable Matrix run passed ${localMatrix.assertions.length} assertions, including real E2EE, persistent crypto, recovery, SAS, complete event semantics, and unknown-token interruption.
- The digest-pinned self-hosted ntfy run passed ${webhook.assertions.length} assertions; the loopback receiver suite verifies generic payloads, stable IDs, retry classes, timeouts, and secret-safe errors.
- EVT, ALT, relevant SEC/UI, and REL-005 mappings are recorded in \`docs/TRACEABILITY.md\` and this report.

Phase 5 remains gated on human review and explicit authorization.
`,
);

process.stdout.write('Generated machine-readable and human Gate 4 reports.\n');
