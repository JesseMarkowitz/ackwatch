# AckWatch implementation plan

Status: **Approved; Phase 4 accepted and Phase 5 authorized**

Prepared: 2026-08-31  
Normative input: [`SPECIFICATION.md`](./SPECIFICATION.md)  
Research input: [`RESEARCH_AND_DESIGN_REVIEW.md`](./RESEARCH_AND_DESIGN_REVIEW.md)

## 1. Execution principles

This plan is designed for long autonomous work intervals separated by a small number of human checkpoint gates. Within an authorized phase, Codex will inspect, implement, test, diagnose, and document without asking the human to perform routine development work.

The boundaries are:

- No application code or dependency environment is created until Checkpoint 0 is approved and the setup phase is explicitly authorized.
- The human has created the adopted `ackwatch` workspace and initialized Git there. Codex will never commit or push.
- The human reviews and executes every `git commit` and `git push` command.
- Secrets enter through ignored local files/environment variables or CI secret storage, never tracked files or chat output.
- A phase stops for human input only at its checkpoint, on a material specification choice, or when an external permission/credential is genuinely required.
- A failed automated check is normal implementation work, not automatically a human checkpoint.
- Product code and test code are developed together; a phase is not complete when its gated tests are absent.

## 2. Checkpoint map

| Gate | Human decision | Evidence Codex supplies | Work unlocked |
| --- | --- | --- | --- |
| 0 — Specification | Approve specification, open product choices, and this plan; name is already adopted | Documents only | Workspace setup |
| 1 — Foundation | Approve toolchain, repository shape, static shell, and visual direction | Clean checks, dependency/license report, screenshot gallery, proposed initial commit commands | Matrix connection proof |
| 2 — Coverage proof | Approve unencrypted baseline/reconnect/gap behavior | Scripted and real-Matrix reports, browser video/screenshots, diagnostics | Queue domain and persistence |
| 3 — Workflow alpha | Approve queue semantics and practical UI | Domain/property/migration tests, real-room workflow demo, screenshot diffs | E2EE, full events, alerts |
| 4 — Reliability beta | Approve encrypted behavior, alerts, and fault UX | Fault-injection report, E2EE run, accessibility/visual gallery | Release hardening |
| 5 — V1 release candidate | Approve release limitations and artifacts | Full matrix, security/dependency report, clean production build, release notes, proposed commit/tag commands | Human-controlled release |

The human may add a checkpoint, but routine milestone boundaries inside a gate do not require interaction.

## 3. Phase 0 — Approval package (complete)

### Deliverables

- Formal product/system specification with traceable requirement IDs.
- Locked product name and descriptor with naming rationale.
- New execution plan with automated test orchestration and screenshot review.
- Preserved research/design review as non-normative background.
- Explicit list of decisions required before setup.

### Verification

- Documentation links resolve locally.
- No package manifest, source, test, credentials, or environment configuration is created during planning. Git metadata in the destination workspace is human-created; no Codex commit or push is performed.
- The current workspace state is reported accurately.

### Checkpoint 0 decisions

The developer approves or amends:

1. package manager and supported Node line if a preference exists;
2. authorization to begin Phase 1 setup.

## 4. Phase 1 — Controlled workspace setup and foundation

This phase begins only after explicit authorization.

### 4.1 Human-provided workspace precondition

The human-provided `ackwatch` workspace and Git metadata are the starting point for Phase 1. Codex will verify the active path and project-only write boundary after restart. `.agents` and `.codex` remain environment-owned and do not need project writes.

### 4.2 Codex setup work

- Verify all writes resolve inside the project root and temporary paths resolve under `/tmp` only.
- Inspect ownership/mode bits and prove create/edit/delete capability with a disposable file inside the project root.
- Do not run `sudo`, change parent permissions, or make broad recursive permission changes.
- Decide and record pinned Node/package-manager versions in an ADR.
- Confirm the human-created Git repository and record the approved default branch name without changing remote or commit state.
- Create `.gitignore` before dependency installation, covering credentials, local test state, build artifacts, Playwright artifacts, screenshots generated from real accounts, SDK databases, and `.research-sources/`.
- Scaffold React + TypeScript + Vite, strict TypeScript, formatting/linting, Vitest, React Testing Library, and Playwright.
- Establish architectural directories and boundary interfaces without Matrix behavior.
- Add local environment templates containing names only, never values.
- Add `README`, security note, contributing/test instructions, ADR index, and dependency/license inventory.
- Decide whether retained research clones remain ignored or are removed later; they MUST NOT enter the parent repository.

### 4.3 Foundation test infrastructure

- One pure unit test proving the test runner/fake clock.
- One component/accessibility test proving the UI harness.
- One Playwright smoke test against the production build.
- Screenshot harness with deterministic fonts/assets and fixed browser/viewport/timezone/locale.
- A test-only state-catalog entry point that is compile-time excluded from production.
- Artifact manifest and static screenshot-gallery generator.
- Separate commands for fast checks and full browser checks.

### 4.4 Gate 1 evidence

- Formatting, lint, strict typecheck, unit/component tests, production build, and browser smoke pass.
- `dist/` is self-contained and loads at root and configured subpath.
- Secret scanner and tracked-file audit pass.
- Initial static state screenshots at desktop and narrow viewport are available.
- Dependency/license report confirms no production code was copied from incompatible reference projects.
- Codex provides, but does not execute, proposed initial commit commands, for example:

```bash
git status --short
git diff --check
git add --all
git commit -m "chore: establish AckWatch foundation"
```

The exact commands will reflect the actual approved name and files.

## 5. Phase 2 — Matrix connection and coverage proof

Goal: prove the defining monitoring boundary before building the work queue UI.

### 5.1 Milestone 2A — Authentication, ownership, and baseline

Implement:

- homeserver discovery/validation and advertised password login;
- session-only credential store (the only V1 credential mode);
- SDK sync IndexedDB store;
- exclusive per-account/device instance ownership;
- non-throwing SDK listener boundary and developer event ledger;
- connection coverage state machine;
- network-confirmed baseline gate;
- Start/Stop monitoring with in-memory session identity;
- cache, baseline, ready, armed, interruption, fatal, and second-tab UI states.

Automate:

- cached `PREPARED` cannot enable Start;
- first non-cache processed sync enables Start;
- historical messages do not enter the ledger;
- one external post-arm message enters exactly once;
- repeated callbacks and self-authored/local-echo events do not enter twice/as work;
- post-Stop activity is excluded;
- reload returns unarmed;
- second tab never opens the same SDK stores.

### 5.2 Milestone 2B — Reconnect and gap completeness

Implement:

- reconnect/catch-up state transitions;
- limited timeline/timeline reset detection;
- per-room gap-required state;
- buffering, forward backfill, stable ordering, and deduplication;
- retryable `coverage_incomplete` diagnostics;
- serial ingestion with provenance and injected clock.

Automate with scripted sync fixtures/proxy:

- ordinary outage catch-up returns every eligible event once;
- a limited response omits at least one event, backfill supplies it, and output order is recovered-before-buffered;
- duplicate events across pagination/live sync count once;
- recovery failure/retry/reload never presents healthy coverage prematurely;
- normalization/listener failure cannot escape into the SDK callback;
- context pagination never creates new work accidentally.

### 5.3 Real Matrix controller, first slice

Build the independent controller with the local mode as the required core path and support an additional compatibility mode:

1. ephemeral local homeserver with automatically provisioned users; and
2. developer-provided homeserver/users through secrets.

The controller creates a unique private room, invites and joins the monitor, sends a unique baseline, starts the browser app, waits for ready, arms through the UI, sends unique post-arm messages, and compares server event IDs with the developer ledger. It then stops, sends another message, rearms after baseline, and proves exclusion.

Every wait MUST poll an observable condition with a deadline. Fixed sleeps MAY be used only for bounded debounce settling, never as the primary synchronization mechanism.

### 5.4 Gate 2 evidence

- All 2A/2B fixture tests pass.
- Local real-Matrix flow runs unattended from room creation through cleanup.
- Developer-provided homeserver flow passes when credentials are available; otherwise it is explicitly skipped, not falsely passed.
- Playwright screenshots show baseline, ready, armed, received event, reconnecting, recovering, incomplete coverage, and second-tab blocked.
- A coverage report maps `AUTH`, `LOCK`, `SYNC`, `GAP`, and `ING` requirement IDs to tests.
- No queue/persistence UI investment beyond the proof ledger is required before this gate passes.

## 6. Phase 3 — Queue domain, durable acceptance, and workflow UI

### 6.1 Milestone 3A — Pure queue domain

Implement the domain without imports from React, Matrix SDK, IndexedDB, browser globals, or wall-clock APIs:

- activities, stable item/cycle identities, conversation keys;
- statuses, counters, attention flags, deadlines, and sorting;
- all explicit commands and deterministic effects;
- thread promotion/racing merge;
- fake clock and generators/builders.

Automated coverage includes:

- a table test for every state/command pair;
- initial, additional, reviewed, acknowledged, completed, and reopened cycles;
- deadline invariants and exact boundary times;
- edits/redactions/decryption enrichment never count or alert;
- stable ordering under tied timestamps;
- thread promotion/merge under both arrival orders;
- duplicate sequence replay and property-based invariants;
- malformed commands have no partial mutation.

### 6.2 Milestone 3B — Transactional persistence

Implement:

- versioned workflow database and validated records;
- atomic event/item/transition/effect/issue repository operation;
- unique account/event key and conversation key constraints;
- durable alert-effect intent without dispatch yet;
- storage health, persistence request, corruption quarantine, and fatal handling;
- account-scoped settings persistence and settings export/import without cross-device synchronization;
- restore-on-reload while monitoring stays OFF.

Automated coverage includes:

- atomic commit and injected rollback at each write point;
- concurrent duplicate insertion;
- reload restoration for every state;
- migrations from every released schema fixture;
- thread promotion/merge in one transaction;
- blocked upgrade, terminated database, quota/storage denial, and corrupt record handling;
- real Chromium and Firefox IndexedDB behavior.

### 6.3 Milestone 3C — Practical attention UI

Implement:

- health header and persistent fault area;
- Needs attention, Open work, and Completed history;
- item details and all domain actions;
- age/deadline presentation and non-color urgency;
- Matrix URI/copy action;
- keyboard/focus behavior, reduced motion, and ARIA announcements.

React MUST dispatch domain commands through application services. It MUST NOT reproduce transition rules.

### 6.4 Expanded Matrix automation

The controller now performs:

- three-user group-room ordering;
- room created/invited/joined during the suite;
- independent messages and threads;
- edit and redaction;
- stop/rearm, completion, and new-activity reopen;
- workflow action automation through the browser;
- reload restoration.

### 6.5 Gate 3 evidence

- Requirement coverage for `QUE`, `DDL`, `DB`, and base `UI` is complete.
- Mutation/property/migration tests pass.
- The unattended real-Matrix workflow reaches create/invite/join/send/listen/view/acknowledge/complete/reopen/reload without human interaction.
- Screenshot gallery covers every principal queue state at desktop and narrow viewport with approved deterministic content.
- Codex supplies proposed commit message/commands; human reviews and executes them if desired.

## 7. Phase 4 — E2EE, complete event semantics, and alerts

### 7.1 Milestone 4A — E2EE and credential hardening

Implement:

- Rust/WASM crypto initialization before sync start;
- stable per-account/device crypto database naming;
- encrypted placeholder commit and late enrichment;
- retryable failure reason codes;
- supported device verification, secret storage, and key backup flows needed for a durable Matrix device;
- refresh-token rotation and unknown-token behavior;
- explicit logout/store cleanup choices;
- full browser detail resolved on demand from SDK/crypto stores; no full decrypted bodies in AckWatch workflow storage;

Tests cover persistent device reload, unknown session, delayed/withheld keys, failure then success, key backup restore, verification, logout, lock contention, and crypto initialization failure.

### 7.2 Milestone 4B — Event and thread completeness

Implement the approved V1 event table:

- text, notice, emote, image/file metadata;
- encrypted forms;
- stable threads, root lookup, promotion/merge;
- edits and redactions;
- explicit ignore/diagnostic decisions for protocol noise and unsupported content.

Tests use sanitized fixtures and real server event IDs. Missing context/decryption can degrade content but cannot suppress accepted work.

### 7.3 Milestone 4C — Alerts and escalation

Implement:

- post-commit effect dispatcher and retry ledger;
- centralized absolute-deadline scheduler;
- bundled audio, unlock confirmation, volume/mute, and visible faults;
- browser notification permission and deterministic tags;
- optional generic JSON webhook transport and ntfy-compatible public/self-hosted preset;
- privacy-tiered webhook payload builder and credential-store integration;
- webhook test action, CORS/CSP diagnostics, independent health, bounded retries, and manual retry;
- startup/focus/visibility/pageshow deadline evaluation;
- best-effort external delivery semantics and diagnostics.

Automated coverage uses fake time for all domain decisions and browser API shims for granted/denied/unsupported/failure modes. Webhook integration tests use a local controllable HTTP receiver to assert payload privacy, authorization redaction, deterministic effect IDs, post-commit dispatch, retry/backoff, rate limiting, timeouts, CORS failures, and 2xx/4xx/5xx handling. A containerized self-hosted ntfy instance validates the preset without depending on ntfy.sh. Browser tests use short test-only thresholds without changing production defaults.

### 7.4 Fault-injection qualification

Exercise:

- long and repeated network failures;
- limited gaps and failed backfill;
- duplicate and malformed events;
- delayed/failed decryption;
- token expiry;
- browser backgrounding/fake sleep and clock advancement;
- storage failure/quota/corruption;
- alert dispatch crash windows;
- webhook endpoint outage, CORS denial, rate limiting, invalid credentials, receiver duplication, and recovery;
- reload at each transaction/effect boundary;
- second-tab races and lock loss.

### 7.5 Gate 4 evidence

- Automated E2EE real-homeserver run passes with disposable accounts.
- Matrix controller completes encrypted room creation/invite/join, encrypted sends, threads, edit/redaction where supported, and cleanup.
- Fault suite proves failures remain visible and healthy coverage is never overstated.
- Generic and ntfy-compatible webhook suites prove post-commit delivery, privacy tiers, stable effect IDs, retry recovery, and secret-safe diagnostics.
- Accessibility scans and keyboard scripts pass.
- Visual review covers encrypted placeholders, faults, notification/audio/webhook states, overdue states, and recovery.
- Browser/API limitations and any skipped platform behavior are explicit.

## 8. Phase 5 — V1 release hardening

### 8.1 Deployment and security

- Test static root/subpath hosting and Matrix CORS troubleshooting.
- Derive and test the restrictive CSP against actual production WASM/workers/assets/connections.
- Disable or privately handle production source maps.
- Add storage status/export/clear and redacted diagnostics export.
- Complete privacy, security, browser support, backup/retention, and limitations documentation.
- Run dependency vulnerability/license audits and secret scan.
- Confirm no remote runtime assets/telemetry.

### 8.2 Performance and longevity

- Generate at least 10,000 activities/1,000 items and measure startup, render, command, scheduler, and migration behavior.
- Run a bounded multi-hour soak with automated message production, periodic workflow actions, reconnections, and artifact capture.
- Verify no growing listener/timer/client duplication and record browser memory observations.

### 8.3 Full release matrix

The release command MUST execute, in a documented order:

- format check;
- lint;
- strict typecheck;
- unit/property/component tests;
- fake and real IndexedDB integration tests;
- Matrix fixture/proxy tests;
- generic webhook receiver and self-hosted ntfy integration tests;
- production build and CSP/static-host smoke;
- Playwright Chromium and Firefox system/accessibility/visual tests;
- WebKit where available;
- local real-Matrix unencrypted and E2EE scenarios;
- developer remote-homeserver scenarios when secrets are present;
- dependency/license/secret scans;
- screenshot gallery and test report generation.

### 8.3a Phase 5 decisions (approved 2026-09-02)

These were decided by the developer during Phase 5 and are normative for the remaining work.

- **Session scope.** AckWatch monitors for a working session, not indefinitely. Recorded as SES-001–009 and ADR-0010. Ending a session archives a redacted summary before clearing its work; account configuration is preserved. The continuity window is measured from session start and defaults to 12 hours, configurable. Measuring from session start rather than last activity was chosen knowing a session open longer than the window is retired on the next reload even if the user never left.
- **Escalation.** At most the currently due stage is materialized (DDL-007).
- **Deployment and CSP.** V1 ships a documented CSP template with a placeholder the deployer fills in with their homeserver and webhook origins. This keeps self-hosting and arbitrary homeservers possible at the cost of a documented setup step.
- **Performance targets at 10,000 activities / 1,000 items.** Command under 100 ms, per ingested event under 50 ms, one scheduler pass under 500 ms. Measured against `npm run test:scale`.
- **Browser matrix.** Chromium and Firefox are required. WebKit runs advisory-only through Playwright, and the release notes must state plainly that this is not real Safari. **Amended 2026-09-03: WebKit is out of scope for V1 and is not run.** Playwright's WebKit on Linux exercises WebCore, not Safari, and the failures most likely to matter to a local-first application in real Safari are platform policies it cannot reproduce — Intelligent Tracking Prevention evicting IndexedDB after seven days of disuse, which is the single largest Safari risk to an app whose entire state is IndexedDB; notification permission requiring a user gesture; iOS home-screen behaviour. It could therefore neither license a Safari support claim nor disprove one: no result it produces changes a decision. Set against that, its Playwright build needs 117 host packages — the gstreamer and libav codec stacks, OpenCL, CJK fonts, xvfb — for an application that plays one 100-byte inline WAV. Chromium and Firefox are the supported engines, Safari is documented as unsupported, and `navigator.storage.persist()` — the one WebCore-level gap that would have shown up — is already guarded in `storage-health.ts`. The Playwright project and `test:browser:webkit` script stay wired so a later release can opt in; the Gate 5 report records the absence as this decision rather than an open skip.
- **Soak.** Six hours, modelling a double shift, since the product is used across three-hour shifts and occasional doubles. Scheduled by the developer because it occupies the machine.

### 8.3b Phase 5 outstanding work (as of 2026-09-03)

Everything else in Phase 5 is delivered and green under `npm run check:gate4`. What remains:

1. **Gates 1–3 still hardcode their step verdicts.** Only the Gate 4 and Gate 5 reports derive them from recorded markers. Retrofitting accepted gates is a developer decision.

**Closed 2026-09-03: the six-hour soak.** Ran for its full 360 minutes with `smokeRun: false`, acknowledging 1,040 of 1,040 items across 23 reconnects with no uncaught page errors. Live timers held flat at 8 and documents at 1; heap, listeners and DOM nodes all grew linearly with retained work and none superlinearly. Gate 5 accepted it as the §8.2 longevity evidence.

**Deferred 2026-09-03 to end-of-project cleanup: the test homeserver's open registration.** The remote homeserver advertises only `m.login.dummy`, so `enable_registration` is on but `registration_requires_token` is not, and anyone can create an account. The developer is still testing against it and is keeping it open deliberately. The remote controller records `registrationTokenRequired` in its manifest, so the state stays visible in the evidence rather than assumed. At project close the homeserver is to be **cleaned out entirely**, not merely tightened.

**Declined 2026-09-03: the advisory WebKit run.** WebKit is out of scope for V1; the reasoning is recorded in §8.3a under the amended browser-matrix decision. Its absence is a decision the Gate 5 report records, not a skip it holds open, so the gate can reach `pass`. The Playwright project and `npm run test:browser:webkit` remain wired for a later release that decides otherwise.

**Closed 2026-09-03: per-event cost at the stress ceiling.** 64 ms against a 50 ms target at 10,000 activities / 1,000 items is accepted for V1. Every other target is met at that ceiling, and every target including this one is met at a realistic session size (2,000 / 200). Closing the gap means incremental item maintenance, whose failure mode is stale or duplicated items after a thread merge deletes one — a correctness risk not worth taking on for a cost that appears only at five times realistic load. The number is recorded as an accepted deviation by the Gate 5 report rather than hidden by a loosened threshold, and stated in `RELEASE_NOTES.md`.

### 8.3e Pre-release items from live testing (2026-09-04)

1. **No layout has been reviewed below a large desktop.** All live testing has run on one wide
   monitor. The visual catalog renders a desktop and a narrow viewport, but nobody has looked at the
   result on a real phone or a small laptop, and the item detail dialog in particular spends a lot of
   vertical space on its header — affordable at 1440px, possibly not at 800. Review every screen at
   a range of widths, and decide what the product actually claims about mobile, before release.

**Closed 2026-09-04: the audio readiness overclaim.** `prepareForMonitoring` reported the audio channel as `Ready` on the strength of the muted unlock, which every browser permits unconditionally, so the indicator was green on a machine where no tone could be heard. It now reports `untested`; only the test tone or a delivered alert, both of which play unmuted at the configured volume, reach `ready`. The distinction is asserted in `src/application/browser-alert-coordinator.test.ts` against a transport that permits muted playback and refuses audible playback, which is the machine the developer actually had. Whether a person *hears* the tone is outside what a page can observe, and the interface now says so rather than implying the indicator settles it.

**Closed 2026-09-04: configuration moved off the monitoring board.** Alert delivery, local durability, durable device security, settings export/import, diagnostics and clear-stored-data now live on a `#/settings` route reached from the top bar. Exhausted alert deliveries deliberately stayed on the board: a failed delivery is a decision waiting on the operator, not a setting.

### 8.3d Open product questions raised in live testing (2026-09-04)

Both were found by driving the application against a real homeserver. Neither is a defect: each is a
decision that must be taken before the first release, and each amends a stated requirement rather
than filling a gap.

**1. Reactions do not alert, and should.** Only `m.room.message` and `m.room.encrypted` are ingested;
everything else is recorded as `unsupported_event_type`. **EVT-009** requires reactions to be
"intentionally ignored", and §81 lists "reactions as work" as an explicit non-goal — so alerting on
them is a specification change, not a bug fix.

The difficulty is that the case the developer cares about is a reaction to **their own** message,
and their own messages never create queue items, because self-authored activity is excluded. That
exclusion is what makes the direct-message behaviour correct today. Three shapes were identified:

1. _Reactions to others' messages only._ Attaches to an item that already exists, so it is a small
   change — and it misses the case that prompted the request.
2. _Track own messages as latent items_ that surface only when reacted to. Delivers what was asked
   for, weakens self-authored exclusion, and needs a rule for when a latent item expires.
3. _A separate "responses to you" channel_, distinct from the attention queue. Cleanest
   conceptually, largest change.

Whichever is chosen must amend EVT-009 and §81 explicitly rather than letting them drift.

**1b. Self-authored messages are dropped at ingestion, so the detail view shows half a
conversation.** A message from the operator is discarded as `self_authored` and never stored, which
is correct for alerting — you should not be alerted about your own words — but it also means the
item's history omits your side entirely. For a thread you took part in, the record you consult is
partial. It has a second consequence: replying in another Matrix client does not settle the item,
because AckWatch cannot see that you replied, so the work stays in the queue until you acknowledge
it by hand. That may well be right for a product built on explicit acknowledgement, but it should be
a decision rather than a side effect. Recording own messages as context without alerting on them
shares a root with the reactions question above: both require tracking the operator's own messages,
and neither should be decided alone.

**2. Mentions and direct messages are addressed to a person, not a room, and rank the same as
anything else.** A message that names the operator, or arrives in a two-person room, is a request
directed at them; a message in a busy room may be addressed to nobody in particular. The queue
currently cannot tell these apart, so a direct request sorts beside ambient traffic. What "extra
priority" should mean — ordering, a distinct deadline, a louder alert, a separate section, or some
combination — is undecided, as is whether a room's member count is a sound proxy for "direct".

### 8.3c Soak and Gate 5 tooling (2026-09-03)

- **The soak now acknowledges.** `Acknowledge` is rendered only inside the item detail dialog, never on a queue card, so the controller's top-level lookup for it matched nothing and the count stayed at zero — which in turn made `acknowledged % 3 === 0` permanently true and completed an item on every pass. The controller now opens an item the way an operator does, and completion is edge-triggered on an acknowledgement rather than level-tested on the running total. Queue cards carry `data-status` so the harness can select a genuinely pending item instead of guessing.
- **The soak now measures what it claims to.** `performance.memory` is bucketed and cached in Chromium, which is why an earlier smoke run reported an identical heap in all eight samples while the queue grew from zero to twenty-two; `growthRatio: 1` was an artefact, not a result. Heap now comes from CDP after a forced collection, alongside live DOM listener, node, document and frame counts, plus a live-timer census installed in the page — the "listeners, timers, clients, memory" the section has always claimed to watch.
- **The soak now has a verdict.** It previously set `result: 'pass'` unconditionally on completion. It now records explicit checks — workflow exercised, reconnects injected, no uncaught page errors, no unexplained console errors, and growth in heap/listeners/timers/documents under a 1.5× ceiling — and fails on any decisive one. Growth checks are advisory on a sub-hour smoke run, which cannot establish a shift-length trend; everything else is judged the same at any length. Console noise is classified against named patterns, the same discipline the Gate 4 report applies to the Matrix run.
- **Gate 5 has a report and a chain.** `npm run check:gate5` adds `test:scale` to the Gate 4 sequence and ends in `report:gate5`. The six-hour soak and the advisory WebKit run are deliberately **not** in the chain — the soak is scheduled separately by decision in §8.3a, and WebKit cannot run here — so the report verifies their recorded manifests instead, and refuses to accept a smoke-length soak as longevity evidence. Anything absent is recorded as an explained skip and the gate reports `incomplete` rather than `pass`; §8.4 asks for no unexplained skips, so a step that did not run can never pass as silence.
- **The advisory WebKit run no longer overwrites required evidence.** `test:browser:webkit` shares `playwright.config.ts` with the required engines, so it was writing over `artifacts/reports/browser-results.json` — the Chromium and Firefox results the gate reports read. It now writes `webkit-results.json`.
- **The Gate 5 report checks that the screenshot gallery matches `HEAD`.** §8.4 asks for human-approved baselines, and approval only means something against the worktree they were rendered from.

### 8.4 Gate 5 evidence

- Full report with no unexplained skips.
- Release requirement traceability matrix.
- Human-approved screenshot baselines.
- Clean tracked-file/secret audit and reproducible production artifact.
- Release notes with honest browser/closed-page/notification limitations.
- Codex provides exact human-run commands for final commit, optional tag, remote addition, and push. Codex executes none of them.

## 9. Test architecture details

### 9.1 Command groups

Exact names are set during setup, but the project SHOULD expose stable equivalents of:

```text
check:fast          format + lint + typecheck + unit/component
test:integration   persistence + Matrix fixtures/proxy
test:browser       production-build Playwright tests
test:visual        screenshot catalog + diffs + gallery
test:matrix:local  provision local homeserver and run protocol/system suite
test:matrix:remote run against developer-provided disposable accounts
test:full          all release-eligible checks
```

CI and humans use the same underlying scripts as Codex. No critical verification should exist only as an undocumented interactive procedure.

### 9.2 Credential contract

The setup phase will provide a tracked `.env.test.example` with empty names and an ignored `.env.test.local`. Expected inputs are:

```text
ACKWATCH_MATRIX_HOMESERVER_URL
ACKWATCH_MATRIX_MONITOR_USER_ID
ACKWATCH_MATRIX_MONITOR_PASSWORD
ACKWATCH_MATRIX_SENDER_A_USER_ID
ACKWATCH_MATRIX_SENDER_A_PASSWORD
ACKWATCH_MATRIX_SENDER_B_USER_ID
ACKWATCH_MATRIX_SENDER_B_PASSWORD
```

Access-token variants MAY be added. Password variables MUST never be printed, embedded in command-line arguments visible to process listings where avoidable, included in screenshots, or copied to reports.

### 9.3 Test-room lifecycle

- Names use an unmistakable prefix plus run ID and timestamp.
- The run manifest records room IDs, aliases if any, user roles, and synthetic event IDs but no credentials or decrypted private text.
- Test messages use synthetic, non-sensitive unique markers.
- Cleanup attempts leave/forget rooms for every fixture user and reports failures.
- On shared developer servers, destructive room purging is not assumed; retention is disclosed before use.
- A cleanup-only command can consume a prior manifest.

### 9.4 Determinism and flake policy

- Use fake clocks for domain/scheduler logic and fixed clocks for screenshots.
- Use server event IDs and explicit observable predicates for system synchronization.
- Seed random/property tests and report seeds.
- Retries are allowed only around known external eventual consistency and MUST preserve the first failure evidence.
- A flaky test is a defect. It cannot become permanently retried or quarantined without a recorded issue, owner, and expiry.

### 9.5 Screenshot policy

- Screenshot state fixtures are typed and share public domain contracts, not internal UI mutation shortcuts.
- Production builds fail if test-state routes or fixture payloads are present.
- Browser, viewport, device scale, locale, timezone, fonts, motion, and color scheme are fixed per baseline.
- Real-integration screenshots use synthetic room/user display names and are stored as ephemeral artifacts unless explicitly approved.
- Codex generates diffs and candidate baselines; only a human decision accepts intentional visual change.

## 10. Traceability and definition of done

Every requirement in the specification will appear in a traceability table with one of:

- `automated-unit`;
- `automated-integration`;
- `automated-browser`;
- `automated-real-matrix`;
- `manual-gate` with justification;
- `deferred` with an approved specification amendment.

A milestone is done only when:

- code, automated tests, and user/developer documentation agree;
- all milestone checks pass locally;
- no unexpected secrets or unrelated workspace files are included;
- known limitations are recorded;
- generated artifacts are reviewable;
- requirement mappings are updated;
- proposed human-run Git commands are supplied at the checkpoint.

## 11. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Matrix limited sync silently skips activity | Mandatory gap detection/backfill and unhealthy state on failure before queue work proceeds |
| Cached readiness admits backlog | Network-confirmed baseline test gate |
| Multiple tabs corrupt crypto state | Lock before any SDK store/crypto initialization |
| Shared remote homeserver cannot induce gaps | Scripted proxy plus local homeserver fault controls |
| Real E2EE setup becomes interactive | Pre-provision disposable verified devices/key backup through test controller where supported; isolate unavoidable recovery UX in a gated browser flow |
| Browser timers/audio/notifications are unreliable | Absolute deadlines, lifecycle catch-up, health indicators, fault injection, honest guarantees |
| Webhook leaks message content or credentials | Generic payload default, explicit preview opt-in, credential boundary, URL/header redaction, synthetic test payload |
| Browser cannot reach a self-hosted webhook | HTTPS/CORS/CSP preflight test, visible health, local receiver tests, and later Tauri transport option |
| Screenshot tests become brittle | Small semantic state catalog, deterministic environment, human baseline approval |
| Test rooms accumulate remotely | Unique prefix, run manifest, automated leave/forget, cleanup-only command |
| Browser tokens are exposed by XSS/local profile | Session-only default, no third-party runtime code, restrictive CSP, explicit warning |
| Codex changes external repository state | Hard prohibition on commit/push/GitHub mutation; commands only for human execution |
| Workspace permissions expand beyond project | No sudo/broad chmod; verify project-only write boundary and use `/tmp` only for ephemeral work |

## 12. Work explicitly deferred beyond V1

- Tauri 2 wrapper and native background/tray/notification/keychain behavior.
- Cross-device workflow synchronization and conflict resolution.
- Multi-account active UI.
- Server push/service-worker closed-page monitoring.
- **Notifications on iOS ("PWA tier 2").** V1 ships tier 1: a web app manifest and icons, so the
  application installs to an iOS home screen and runs without browser chrome. That is a layout and
  packaging change only — there is no service worker, and installing alters no behaviour.
  Notifications on iOS need more: Apple exposes them only to a home-screen web app **and** requires
  them to be raised through `ServiceWorkerRegistration.showNotification()`, where AckWatch uses the
  `Notification` constructor (itself deprecated in Chrome on Android, so this would eventually be
  worth doing regardless). Taking it on means adding a service worker to an application whose whole
  claim is local durability — with its cache-staleness failure modes — extending the CSP for it,
  and reworking the notification transport. It also reverses the §8.3a decision that Safari is out
  of scope, which cannot be half-taken: shipping iOS notifications while documenting iOS as
  unsupported is not a coherent position. One input to that decision needs checking first, and has
  not been: whether an *installed* home-screen web app is subject to the seven-day ITP eviction of
  IndexedDB that the §8.3a reasoning rests on, or whether installation exempts it.
- Room creation, invitation management, or message composition in the user-facing app.
- Advanced filtering by spaces/DM classification until all-joined-room reliability is proven.

These may be planned after V1 without weakening the current coverage and transactional guarantees.
