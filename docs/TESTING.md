# Testing and artifacts

## Command groups

- `npm run check:fast`: formatting, lint, strict typecheck, and unit/component tests.
- `npm run test:browser`: Chromium and Firefox against the production build at both root and the
  `/ackwatch/` subpath.
- `npm run test:visual`: deterministic Chromium state screenshots and an HTML gallery.
- `npm run test:matrix:local`: fresh pinned Synapse, three synthetic users, browser monitoring
  boundary assertions, cleanup, and teardown.
- `npm run test:matrix:remote`: runs against a developer-provided homeserver, and explicitly records
  a skip when neither a registration token nor account credentials are supplied. Given
  `ACKWATCH_MATRIX_HOMESERVER_URL` and `ACKWATCH_MATRIX_REGISTRATION_TOKEN` it provisions three
  disposable accounts per run, then deactivates and erases them; given the six account variables it
  uses those accounts and never deactivates them, because they are someone's real accounts. The
  manifest records which registration stage the homeserver asked for, so a server that accepts
  registration without a token is visible in the evidence rather than assumed.
- `npm run test:browser:webkit`: advisory only, never part of a gate. Install it first with
  `npm run setup:browsers:webkit`. WebKit through Playwright is not Safari and must not be described
  as Safari support.
- `npm run test:webhook:local`: pinned self-hosted ntfy contract and redacted manifest.
- `npm run test:scale`: drives the real repository against real IndexedDB in Chromium at ten
  thousand activities, publishing a growth curve to `artifacts/reports/scale-summary.json`. The
  ladder and item count are overridable through `ACKWATCH_SCALE_LADDER` and `ACKWATCH_SCALE_ITEMS`.
  Checkpoints are written as they land, so an overrunning run still yields its measurements.
- `npm run check:gate1`: the complete Phase 1 gate, including audits and reports.
- `npm run check:gate2`: the complete Phase 2 gate and evidence report.
- `npm run check:gate3`: the complete Phase 3 workflow gate, including native IndexedDB,
  deterministic queue visuals, and the expanded real-Matrix workflow.
- `npm run check:gate4`: the Phase 4 reliability gate, including E2EE, recovery/SAS, complete event
  semantics, local receiver contracts, self-hosted ntfy, alert faults, and Phase 4 visuals.

Steps in the Gate 4 chain that leave no artifact of their own record a marker under
`artifacts/reports/steps/` as they pass, and the chain clears those markers before it starts. The
Gate 4 report reads them rather than asserting that a step it never observed succeeded, so it
cannot be generated from a partial run.

WebKit additionally needs system libraries that Playwright installs with `sudo`; on a machine
without them the advisory project cannot run at all, which is a limitation of the machine and is
recorded rather than worked around.

Run `npm run setup:browsers` once after installation to place the pinned Chromium and Firefox
binaries in the ignored project cache.

The production and catalog servers bind only to `127.0.0.1`. Browser waits use visible predicates;
fixed sleeps are not used as synchronization.

## Matrix integration controller

The required controller creates a fresh `.matrix-test-state/synapse` directory, generates a
Synapse configuration inside the pinned container, registers three random-password users, creates
a unique private room, and drives AckWatch through its real UI. It proves pre-arm exclusion,
post-arm intake, view/acknowledge, edit/redaction, thread merge, complete/reopen, self and
stopped-window exclusion, rearm, durable reload restoration, second-tab blocking, actual encrypted
wire text/thread traffic, on-demand decrypted detail, persistent crypto reload,
cross-signing/secret-storage/key-backup setup, new-device recovery, own-device emoji SAS, and
visible unknown-token interruption.
All waits poll observable HTTP, UI, or event-ID conditions with deadlines.

The disposable homeserver runs with rate limiting disabled. The scenario signs the monitor in
several times over — this controller's own session, the browser, and again as a fresh device after
the deliberate account-wide logout — which a default Synapse answers with `429`. Rate limiting is
homeserver behaviour this suite does not qualify.

Every browser console error and page error is recorded verbatim in the run manifest, with the
failing URL and the scenario phase that was running. The Gate 4 report, not the controller, decides
which of them are known rig noise; anything outside that documented list fails the gate. Judging
them in the report keeps the list reviewable and re-runnable against a stored manifest instead of
costing another homeserver run.

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

## Webhook integration controller

The loopback HTTP contract test captures real request headers and bodies and covers stable
idempotency, bearer placement, privacy exclusions, rate limiting, response-body redaction, and
timeouts. `test:webhook:local` starts the digest-pinned ntfy container on loopback, publishes through
the product adapter, independently polls the topic, records only version/assertion metadata, and
always removes its container and volumes. The ordinary unit command explicitly skips this one test
when `ACKWATCH_NTFY_URL` is absent.

## Credentials

The required real-Matrix suite provisions a disposable local stack and requires no human
credential. Optional remote compatibility values go in ignored `.env.test.local`, using only the
names in `.env.test.example`. Test code must never print those values or put passwords in command
arguments, screenshots, manifests, traces, or reports.

## Flake policy

Random inputs are seeded and seeds are reported. Retries are limited to known external eventual
consistency and retain the first failure evidence. A flaky test is a defect, not a passing run.
