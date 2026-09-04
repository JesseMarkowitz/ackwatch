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
- `npm run test:browser:webkit`: **out of scope for V1 and not run** (§8.3a, amended 2026-09-03).
  The project stays wired so a later release can opt in: install it with
  `npm run setup:browsers:webkit`, then the 117 host packages with
  `sudo ./node_modules/.bin/playwright install-deps webkit`. It writes its own results file so an
  opt-in run can never overwrite the required Chromium and Firefox evidence. WebKit through
  Playwright is not Safari and must not be described as Safari support.
- `npm run test:webhook:local`: pinned self-hosted ntfy contract and redacted manifest.
- `npm run test:scale`: drives the real repository against real IndexedDB in Chromium at ten
  thousand activities, publishing a growth curve to `artifacts/reports/scale-summary.json`. The
  ladder and item count are overridable through `ACKWATCH_SCALE_LADDER` and `ACKWATCH_SCALE_ITEMS`.
  Checkpoints are written as they land, so an overrunning run still yields its measurements.
- `npm run check:gate1`: the complete Phase 1 gate, including audits and reports.
- `npm run check:gate2`: the complete Phase 2 gate and evidence report.
- `npm run check:gate3`: the complete Phase 3 workflow gate, including native IndexedDB,
  deterministic queue visuals, and the expanded real-Matrix workflow.
- `npm run test:soak`: the §8.2 longevity run. It boots a disposable Synapse, drives the real UI for
  `ACKWATCH_SOAK_MINUTES` (360 by default), produces messages at a human cadence, works the queue as
  an operator would, drops and restores the connection, and samples to
  `artifacts/soak/soak-samples.jsonl` as it goes so an interrupted run still leaves what it
  measured. Set a few minutes to smoke-test the harness; a run under an hour is marked `smokeRun`
  and its growth checks become advisory, because three minutes cannot establish a shift-length
  trend.
- `npm run check:gate4`: the Phase 4 reliability gate, including E2EE, recovery/SAS, complete event
  semantics, local receiver contracts, self-hosted ntfy, alert faults, and Phase 4 visuals.
- `npm run check:gate5`: the V1 release matrix — the Gate 4 sequence plus `test:scale`, ending in
  the Gate 5 report.

Steps in the gate chains that leave no artifact of their own record a marker under
`artifacts/reports/steps/` as they pass, and a chain clears those markers before it starts. The gate
reports read them rather than asserting that a step they never observed succeeded, so a report
cannot be generated from a partial run.

The six-hour soak is deliberately outside the Gate 5 chain: it occupies the machine and Docker for
a shift and is scheduled by the developer. The Gate 5 report verifies its recorded manifest instead
and refuses a smoke-length run as longevity evidence. Anything absent is recorded as an explained
skip with the gate reporting `incomplete` rather than `pass` — a step that did not run never passes
as silence.

WebKit is the one exception, and it is an exception because it is a decision rather than a gap. The
report records it as out of scope with the reasoning attached, so it does not hold the gate open. If
that decision is ever reversed, delete the `out-of-scope` branch in `tools/generate-gate5-report.mjs`
and the absence becomes an explained skip again.

WebKit additionally needs 117 system libraries that Playwright installs with `sudo`. That cost,
against a run that could neither license a Safari support claim nor disprove one, is why V1 does not
qualify WebKit; see §8.3a of the implementation plan for the full reasoning.

### What the soak measures

`performance.memory` is not used: Chromium buckets and caches it, so it reports the same figure all
run and a leak is indistinguishable from a flat session. Heap comes from CDP after a forced
collection, alongside live DOM listener, node, document and frame counts and a live-timer census
installed in the page.

Heap, listeners and DOM nodes are judged **per queue item**, not in absolute terms. A shift
accumulates work on purpose — items stay in the queue and completed ones stay in history until an
explicit cleanup — so those three are supposed to grow with the queue, and an absolute ratio would
fail an honest run on its own success. A leak looks like cost per retained item rising. Timers and
documents are per-application rather than per-item and are judged absolutely: working the queue
should add neither.

The run records explicit checks and fails on any decisive one, rather than reporting `pass` for
having reached the end.

Console errors are recorded verbatim and classified by the **Gate 5 report**, not by the controller —
the same rule this file states for the Matrix run, and for a stronger reason: a stored manifest can
be re-judged, whereas a controller that judges at run time makes every misclassification cost
another six hours. The controller originally got this wrong, and one misjudged line failed a
completed run that was healthy in every other respect. One rule is bounded rather than absolute: a
handful of 401s on `/sync` is the refresh-token handshake, since the app logs in with
`refresh_token: true` and Synapse's refreshable tokens are short-lived, so the first expiry surfaces
as a 401 on the in-flight long-poll before the SDK refreshes. Beyond that bound they stay
unexplained and fail the gate, and `workflowExercised` is the backstop either way — a session that
never recovered would acknowledge nothing.

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
