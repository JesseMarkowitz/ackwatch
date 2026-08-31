# Testing and artifacts

## Command groups

- `npm run check:fast`: formatting, lint, strict typecheck, and unit/component tests.
- `npm run test:browser`: Chromium and Firefox against the production build at both root and the
  `/ackwatch/` subpath.
- `npm run test:visual`: deterministic Chromium state screenshots and an HTML gallery.
- `npm run test:matrix:local`: fresh pinned Synapse, three synthetic users, browser monitoring
  boundary assertions, cleanup, and teardown.
- `npm run test:matrix:remote`: explicitly records a skip when optional credentials are absent.
- `npm run check:gate1`: the complete Phase 1 gate, including audits and reports.
- `npm run check:gate2`: the complete Phase 2 gate and evidence report.
- `npm run check:gate3`: the complete Phase 3 workflow gate, including native IndexedDB,
  deterministic queue visuals, and the expanded real-Matrix workflow.

Run `npm run setup:browsers` once after installation to place the pinned Chromium and Firefox
binaries in the ignored project cache.

The production and catalog servers bind only to `127.0.0.1`. Browser waits use visible predicates;
fixed sleeps are not used as synchronization.

## Matrix integration controller

The required controller creates a fresh `.matrix-test-state/synapse` directory, generates a
Synapse configuration inside the pinned container, registers three random-password users, creates
a unique private room, and drives AckWatch through its real UI. It proves pre-arm exclusion,
post-arm intake, view/acknowledge, edit/redaction, thread merge, complete/reopen, self and
stopped-window exclusion, rearm, durable reload restoration, and second-tab blocking.
All waits poll observable HTTP, UI, or event-ID conditions with deadlines.

The controller leaves and forgets the synthetic room for every user, stops the container, removes
volumes, and deletes local server state even after failure. Passwords remain in process memory and
are never written to reports or command arguments. Redacted manifests and real-run screenshots are
under ignored `artifacts/matrix/`.

## Deterministic visual environment

The visual project pins Chromium, viewport, device scale, `en-US`, UTC, light color scheme, reduced
motion, and locally bundled variable fonts. Synthetic typed fixtures drive the catalog. Real Matrix
content must never be used for a tracked baseline.

Candidate PNGs appear in `artifacts/screenshots/`, and the review page appears in
`artifacts/gallery/index.html`. The gallery manifest records the fixture source and environment.
Generated images are evidence, not automatically accepted baselines; a human approves intentional
visual changes at a checkpoint.

## Credentials

The required real-Matrix suite provisions a disposable local stack and requires no human
credential. Optional remote compatibility values go in ignored `.env.test.local`, using only the
names in `.env.test.example`. Test code must never print those values or put passwords in command
arguments, screenshots, manifests, traces, or reports.

## Flake policy

Random inputs are seeded and seeds are reported. Retries are limited to known external eventual
consistency and retain the first failure evidence. A flaky test is a defect, not a passing run.
