# AckWatch product and system specification

Status: **Approved for implementation at defined phase gates**

Version: 1.3

Prepared: 2026-08-31  
Product name: **AckWatch** (adopted 2026-08-31)  
Descriptor: **A local-first attention monitor for Matrix** (adopted 2026-08-31)

Revision 1.3 locks a local disposable Matrix/webhook test stack as the required unattended-test foundation, with developer-provided remote homeserver accounts used optionally for compatibility coverage.

Revision 1.2 locks indefinite completed-history retention with explicit manual cleanup and a configurable 30-day default for diagnostics and webhook-attempt records.

Revision 1.1 locks Matrix event-URI-only linking and the rule that link actions do not mark an item viewed. Revision 1.0 locks strict degraded coverage for synchronization gaps: monitoring intent remains armed, but coverage cannot be healthy until recovery succeeds. Revision 0.9 locked account-scoped local settings persistence and its behavior across sessions, accounts, browsers, and logout. Revision 0.8 locked the default alert/escalation schedule. Revision 0.7 locked on-demand full-detail resolution from SDK/crypto stores rather than full decrypted-body persistence. Revision 0.6 adopted balanced preview privacy: rich, fully decrypted detail in the browser and generic external alerts. Revision 0.5 locked V1 to session-only Matrix credentials with no remembered-login mode. Revision 0.4 adopted the Apache License 2.0 for the project. Revision 0.3 recorded that no prior CLI or other product implementation exists and made this specification the sole behavioral authority. Revision 0.2 locked the product name/descriptor and added optional generic and ntfy-compatible webhook alert delivery.

## 1. Document purpose

This document is the normative specification for a browser application that watches Matrix rooms during an explicitly armed session, turns qualifying incoming messages into durable attention work, and continues alerting until that work is reviewed and completed.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** express requirement strength in the usual [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) sense.

No command-line interface or other prior product implementation was designed, created, or tested. This specification is therefore the sole authority for AckWatch behavior. The research/design review is supporting rationale, not a compatibility target.

## 2. Naming decision

### 2.1 Adopted name

The adopted public name is **AckWatch**. The repository and package stem is `ackwatch`. The adopted descriptor is **“A local-first attention monitor for Matrix.”** Public copy MUST state that the project is independent and is not endorsed by The Matrix.org Foundation or Element.

The name expresses the product's actual distinction: it watches for work that requires acknowledgment. It is more precise than “Notifier,” because a notification is only one effect, and more durable than “Monitor,” because the product manages an attention lifecycle after detection.

### 2.2 Rejected working names

| Name | Decision | Reason |
| --- | --- | --- |
| Element Notifier | Reject | Incorrectly suggests an Element-specific integration or affiliation and understates the queue/workflow behavior |
| Matrix Monitor | Use only as a generic descriptor | Protocol-accurate but generic, difficult to distinguish in search, and not a distinct public identity |
| Matrix Notifier | Reject | Protocol-accurate but still reduces the product to notification delivery |
| AckWatch | Adopt | Distinct, short, and centered on watched-until-acknowledged work |

This recommendation is not a legal trademark clearance. Before a public release, the owner MUST perform or commission the desired trademark, domain, GitHub organization/repository, package-registry, and app-store checks. The current [Matrix.org Foundation Trademark Policy](https://matrix.org/legal/trademark-policy/) also tells open-source projects to choose a distinct identity; therefore official Matrix branding MUST NOT be used as AckWatch branding.

### 2.3 Directory name

The adopted workspace/repository directory name is `ackwatch`. The human developer has created the new workspace at `~/start9-workspace/ackwatch` and initialized its Git metadata. No application implementation is implied by that administrative setup; Codex remains prohibited from committing or pushing.

## 3. Product definition

### 3.1 Problem

Matrix clients provide message history, unread markers, mentions, and notifications, but those mechanisms do not constitute a local work queue with explicit acknowledgment, completion, escalation, and monitoring-coverage health. A user supervising important rooms for several hours needs to know both that incoming work was captured and that unresolved work remains visible.

### 3.2 Product promise

While the application is alive, owns the account instance lock, is explicitly armed, and can synchronize and recover gaps from the homeserver, every qualifying external event it observes or recovers MUST be accepted exactly once into durable local workflow state or surfaced as an explicit ingestion/coverage failure.

AckWatch MUST prefer an honest degraded state over a healthy-looking state that may have missed events.

### 3.3 Target user

V1 targets a single operator using one Matrix account in a desktop browser to monitor all joined rooms for a bounded session of several hours. The schema MUST be account-scoped so multi-account support can be added later without rewriting identities.

### 3.4 Goals

- Establish a network-confirmed baseline before monitoring can start.
- Capture qualifying incoming activity only during an explicitly armed session, including recoverable activity sent during temporary disconnection.
- Present one durable item per independent message or Matrix thread.
- Support viewed, acknowledged, reviewed, completed, and reopened workflows.
- Alert on new and overdue work through local and optional external transports with continuously visible per-transport health.
- Persist workflow data safely and idempotently in the browser.
- Support encrypted rooms using the Matrix SDK's supported Rust/WASM crypto APIs.
- Provide deterministic, mostly unattended automated verification, including real homeserver orchestration and browser screenshots.
- Preserve platform boundaries needed for a later Tauri 2 wrapper.

### 3.5 Non-goals for V1

- Replacing a full Matrix chat client.
- Composing or sending ordinary user messages from the product UI.
- Creating rooms or managing invitations from the product UI.
- Voice/video calling, presence, typing indicators, receipts, reactions as work, moderation, or room administration.
- Monitoring while the page/browser is closed or the process is suspended.
- Server-side push, a hosted backend, or cross-device workflow synchronization.
- Guaranteed sound or desktop notifications in conditions where the browser or OS prevents execution.
- Supporting multiple simultaneously active accounts in one browser profile.

Room creation, invitations, joins, and message posting are REQUIRED test-harness capabilities. They do not expand the V1 user interface into a chat client.

## 4. Supported environment and dependencies

### 4.1 V1 platform

- Static React and TypeScript web application built with Vite.
- Current pinned `matrix-js-sdk` browser entry point.
- IndexedDB for SDK sync data, crypto data, and application workflow data in distinct databases.
- Current desktop Chromium and Firefox as automated release gates.
- Safari/WebKit as an automated gate where the execution environment permits, otherwise a recorded manual compatibility gate.
- HTTPS production hosting; explicit HTTP exception only for loopback development.

### 4.2 Future platform

A later Tauri 2 application MAY replace browser implementations of notifications, credentials, lifecycle, and single-instance ownership. The queue domain, Matrix normalization contract, persistence semantics, and scheduler rules SHOULD remain shared.

## 5. Core concepts

### 5.1 Account

An account is identified by the canonical Matrix user ID plus the selected homeserver/account namespace. All durable application keys MUST be scoped by `accountId`.

### 5.2 Monitoring session

A monitoring session begins only after an eligible user gesture on **Start monitoring** and ends on **Stop monitoring**, logout, page teardown/reload, lock loss, or fatal client shutdown. Monitoring MUST NOT auto-resume after reload or process restart.

### 5.3 Activity

An activity is one qualifying Matrix event accepted during an armed monitoring session, or a later maintenance mutation associated with an already tracked event. Each accepted Matrix event MUST be idempotently keyed by account and event ID.

### 5.4 Queue item

A queue item is the user's durable workflow unit. It represents either one independent event or one Matrix thread and has a stable opaque local ID that does not change during thread promotion or merge.

### 5.5 Attention cycle

An attention cycle begins when a new item is created or completed work is reopened by new qualifying activity/manual action. Cycle identity MUST be stable and MUST scope deadlines and alert-effect IDs.

### 5.6 Coverage

Coverage describes whether AckWatch can truthfully claim it has processed all relevant events across the current monitoring interval. Connection, armed state, audio health, browser-notification permission, and webhook health are independent dimensions and MUST NOT be collapsed into one boolean.

## 6. Functional requirements

### 6.1 Authentication and session handling

- **AUTH-001** The application MUST accept a full Matrix user ID and SHOULD perform `.well-known` homeserver discovery, with an advanced explicit homeserver override.
- **AUTH-002** The application MUST query advertised login flows and offer password login only when `m.login.password` is supported.
- **AUTH-003** The password MUST never be persisted or logged.
- **AUTH-004** V1 MUST use session-only Matrix credentials exclusively. AckWatch MUST NOT offer a remembered-login mode or persist Matrix access/refresh tokens across the browser session.
- **AUTH-005** Refresh tokens SHOULD be requested and rotated when the homeserver supports them.
- **AUTH-006** `M_UNKNOWN_TOKEN` or equivalent loss of authorization MUST disarm monitoring and present a prominent reauthentication-required fault.
- **AUTH-007** Logout MUST stop synchronization, disarm monitoring, release the instance lock, invalidate the remote token when possible, and clear credential/sync/crypto stores. Retaining or deleting local workflow history MUST be a separate explicit choice.

### 6.2 Single-instance ownership

- **LOCK-001** Only one page/client MAY own a given account/device crypto and sync-store namespace.
- **LOCK-002** An exclusive Web Lock or equivalently strong browser primitive MUST be acquired before SDK stores are opened or crypto initializes.
- **LOCK-003** A second tab MUST show an explanatory blocked/read-only screen and MUST NOT start another SDK client against the same stores.
- **LOCK-004** Loss of ownership MUST disarm monitoring and show a fatal coverage fault.

### 6.3 Connection and baseline

The connection coverage states are:

`signed_out`, `starting`, `cache_restored`, `baseline_syncing`, `ready`, `reconnecting`, `catching_up`, `recovering_gap`, `coverage_incomplete`, `fatal_error`, and `stopped`.

- **SYNC-001** Cached SDK `PREPARED` state MUST NOT by itself enable monitoring.
- **SYNC-002** `ready` requires at least one successful non-cache network sync fully processed after startup, no SDK catch-up, an empty application ingestion queue, and no outstanding gap recovery.
- **SYNC-003** Start monitoring MUST be enabled only in `ready`.
- **SYNC-004** Stop monitoring MUST immediately end eligibility for new work; SDK synchronization MAY continue to maintain a fresh baseline.
- **SYNC-005** A temporary connection loss while armed MUST retain logical `armed` state but MUST display interrupted/degraded coverage rather than healthy monitoring.
- **SYNC-006** Page reload, navigation, close, process restart, logout, or lock loss MUST leave the next process unarmed.
- **SYNC-007** Historical/cache events and closed-window backlog MUST NOT create work.

### 6.4 Gap recovery and delivery completeness

- **GAP-001** The adapter MUST detect limited timelines/timeline resets that can represent an event gap.
- **GAP-002** During armed recovery, returned live events for an affected room MUST be ordered behind recovered gap events for application processing.
- **GAP-003** Missing events MUST be requested through supported Matrix pagination/messages mechanisms until boundaries join or recovery is proven impossible.
- **GAP-004** Recovered and buffered events MUST pass through the same normalization and idempotency rules as ordinary live events.
- **GAP-005** Failed/incomplete recovery MUST remain durable/retryable, MUST set `coverage_incomplete`, and MUST prevent a healthy/caught-up indication.
- **GAP-006** Event origin timestamps MUST NOT determine eligibility or alert deadlines. Detection time from the injected application clock is authoritative for recovered work.

### 6.5 Event intake and normalization

- **ING-001** SDK callbacks MUST be non-throwing boundaries that enqueue minimal envelopes for serial processing.
- **ING-002** Ordinary new-work intake MUST require a live, non-backfill timeline delivery after the monitoring boundary. Explicit armed-gap recovery is the only backfill provenance eligible for new work.
- **ING-003** Normalization MUST return one of: supported activity, tracked maintenance mutation, intentional ignore with reason, or visible ingestion issue.
- **ING-004** Context lookup, room-name resolution, root lookup, and decryption MUST NOT delay initial placeholder acceptance.
- **ING-005** Each accepted envelope MUST include account ID, event ID, room ID, delivery provenance, local delivery sequence, detection time, sender, event type, relation metadata, and content state.
- **ING-006** Duplicate delivery of an event ID MUST have no observable workflow or alert side effect.
- **ING-007** Self-authored and local-echo events MUST NOT create new work.

### 6.6 Supported event semantics

- **EVT-001** V1 MUST support incoming `m.room.message` activities with `m.text`, `m.notice`, and `m.emote` message types.
- **EVT-002** V1 MUST support image and file messages using safe filename/media metadata without downloading or storing attachment bytes.
- **EVT-003** V1 MUST support encrypted wire events as immediate placeholders and enrich them after successful decryption.
- **EVT-004** Stable Matrix thread replies MUST group by root. Ordinary `m.in_reply_to` replies MUST NOT be classified as threads.
- **EVT-005** A missing/decryption-failed thread root MUST NOT suppress a qualifying reply; root information is enrichment.
- **EVT-006** Edits to tracked events MUST update the preview/edited marker without incrementing counts, reopening, or alerting.
- **EVT-007** Redactions of tracked events MUST preserve the audit/activity record, replace content with a tombstone, and MUST NOT decrement historical counts or alert.
- **EVT-008** Late decryption, edit, redaction, and context enrichment of tracked work MUST be processed while monitoring is off.
- **EVT-009** Reactions, receipts, typing, presence, membership events, and unsupported message types MUST be intentionally ignored or diagnosed; they MUST NOT silently enter the work queue.

### 6.7 Queue identity and thread promotion

- **QUE-001** Queue items MUST use stable opaque local IDs.
- **QUE-002** An account-scoped conversation key MUST be unique: `event:<roomId>:<eventId>` for independent events and `thread:<roomId>:<rootEventId>` for known threads.
- **QUE-003** When an independent root later becomes a known thread root, promotion and any racing-item merge MUST be atomic.
- **QUE-004** Promotion/merge MUST preserve every unique activity and workflow transition and MUST NOT double-count or emit a second alert for existing work.

### 6.8 Queue state and commands

Active status values are `NEW`, `UNACKNOWLEDGED`, and `ACKNOWLEDGED`; terminal status is `COMPLETED`.

The domain MUST expose explicit commands: accept activity, mark viewed, acknowledge, review new activity, complete, manually reopen, apply edit, apply redaction, enrich decrypted content, promote/merge thread, and evaluate deadlines.

- **QUE-010** First activity creates `NEW`, `activityCount = 1`, and `unseenActivityCount = 1`.
- **QUE-011** Additional activity on `NEW` increments both counts and retains `NEW`.
- **QUE-012** Mark viewed changes `NEW` to `UNACKNOWLEDGED`, sets `firstViewedAt` once, and clears current unseen attention.
- **QUE-013** New activity on `UNACKNOWLEDGED` retains status, increments counts, and sets `needsAttention`.
- **QUE-014** Acknowledge changes `NEW` or `UNACKNOWLEDGED` to `ACKNOWLEDGED`, records `acknowledgedAt`, and marks known activity reviewed.
- **QUE-015** New activity on `ACKNOWLEDGED` retains status, increments counts, and sets `needsAttention`.
- **QUE-016** Review new activity clears current unseen attention without changing `ACKNOWLEDGED`.
- **QUE-017** Complete is available from every active state, records completion, clears active deadlines, and moves the item to completed history.
- **QUE-018** New qualifying activity on `COMPLETED` begins a fresh cycle in `NEW`, increments `reopenedCount`, preserves history, and creates fresh cycle-scoped effects.
- **QUE-019** Maintenance mutations MUST NOT increment monitored activity counts.
- **QUE-020** Invalid commands MUST fail deterministically without partial state changes.

### 6.9 Deadline behavior

- **DDL-001** The unacknowledged deadline is based on the first detected activity in the current cycle; viewing MUST NOT postpone it.
- **DDL-002** The acknowledged/pending deadline is based on the most recent explicit transition into `ACKNOWLEDGED`.
- **DDL-003** New activity and review-new-activity MUST NOT postpone the acknowledged deadline by default.
- **DDL-004** Completion cancels active deadlines; reopen creates new cycle deadlines and effect IDs.
- **DDL-005** Threshold durations MUST be configurable settings with these V1 defaults: immediate initial/reopen alert; unacknowledged escalation after 5 minutes, repeating every 5 minutes; acknowledged-work escalation after 30 minutes, repeating every 15 minutes.
- **DDL-006** A queue item's active deadlines MUST be materialized when its attention cycle begins or when it is explicitly acknowledged. Changing settings MUST affect future cycles and future acknowledgements, but MUST NOT silently move existing deadlines.

### 6.10 Transactional persistence

- **DB-001** Workflow persistence MUST use versioned IndexedDB schemas and runtime validation on read.
- **DB-002** Unique activity insertion, item create/update/promotion/reopen, counters/timestamps/deadlines, deterministic alert-effect insertion, and corresponding issue resolution MUST occur in one transaction.
- **DB-003** The unique account/event ID decides whether an event is new.
- **DB-004** In-memory UI projection and alert dispatch MUST occur only after successful commit.
- **DB-005** Storage failure MUST be visible and MUST NOT degrade silently to volatile in-memory operation.
- **DB-006** The application SHOULD request persistent browser storage after explaining why.
- **DB-007** Export, diagnostics, clear-storage, corruption quarantine, and schema migration behavior MUST be delivered before V1 release.
- **DB-008 — Completed-history retention:** Completed workflow items and their bounded metadata/previews MUST be retained indefinitely until an explicit user cleanup action or browser data eviction. Active and unresolved work MUST NOT be removed by retention cleanup. Diagnostics and webhook-attempt records MUST use a configurable retention period with a V1 default of 30 days.

Required logical stores are queue items, activities, conversation keys, workflow transitions, alert effects, settings, monitoring sessions, and ingestion issues. Exact physical schema is an architecture decision constrained by these semantics.

#### Settings persistence

- **CFG-001** Alert thresholds, repeat intervals, transport enablement, audio/notification preferences, webhook endpoint configuration, preview privacy, and related AckWatch preferences MUST be stored in the versioned local workflow database, not in Matrix account data and not on an AckWatch server.
- **CFG-002** Settings MUST be keyed by `accountId` (canonical Matrix user plus homeserver) so different accounts in one browser profile do not share alert policy or queue preferences.
- **CFG-003** Settings MUST survive reload, ordinary browser restart, logout/login, and returning in a later week when the same browser profile/site data remains. Session-only Matrix credentials MUST still be cleared at the end of the session.
- **CFG-004** Settings MUST remain local to the browser profile. The same account used in a different browser, device, or profile MUST receive independent settings in V1; cross-device settings sync is deferred.
- **CFG-005** Logout MUST clear session credentials and sensitive webhook authentication material. Account-scoped non-secret settings MAY remain when the user retains local workflow history; an explicit erase-local-data action MUST remove them.
- **CFG-006** The diagnostics and webhook-attempt retention period MUST be configurable per account, default to 30 days, and be visibly described before cleanup. Changing it MUST affect future cleanup and MUST NOT delete completed workflow history.
- **CFG-007** The UI MUST show when browser storage is unavailable or at risk of eviction and SHOULD offer settings export/import separately from workflow-content export.

### 6.11 Alerts

- **ALT-001** Alert effects MUST have deterministic IDs scoped by item, cycle, and stage.
- **ALT-002** The scheduler MUST use absolute deadlines and a single periodic wake-up plus startup/focus/visibility/pageshow checks.
- **ALT-003** A late deadline caused by sleep or throttling MUST be evaluated immediately at the next scheduler pass.
- **ALT-004** Sound assets MUST be local build assets. Audio initialization/readiness MUST be tested during the Start monitoring user gesture when sound is enabled.
- **ALT-005** Audio failure/mute and notification permission/availability MUST remain independently visible.
- **ALT-006** Browser notifications are supplemental and MUST NOT be represented as working after the page closes.
- **ALT-007** External audio/notification delivery is best effort; the application guarantees durable effect intent, not exactly-once OS delivery.
- **ALT-008** The alert subsystem MUST provide an optional webhook transport so a user can relay new-activity and escalation notifications to another system.
- **ALT-009** Webhook dispatch MUST occur only after the workflow/effect transaction commits. Every attempt and retry MUST carry the same deterministic effect ID in the payload and, where accepted, an `Idempotency-Key` header.
- **ALT-010** Webhook delivery MUST be disabled by default, independently configurable, independently health-reported, and unable to change queue state or suppress local audible/visual alerts.
- **ALT-011** V1 MUST include a generic JSON-over-HTTPS webhook and an ntfy-compatible preset that accepts a configurable public or self-hosted server, topic, and optional authentication.
- **ALT-012** Webhook and other external alert payloads MUST be privacy-preserving generic notifications. They MUST NOT include room labels, sender labels/IDs, message previews, formatted bodies, attachment names, Matrix event URIs, or raw Matrix events/tokens.
- **ALT-013** Webhook credentials MUST use the credential boundary, MUST be redacted from UI/logs/diagnostics/exports, and MUST NOT be placed in URL query strings by AckWatch.
- **ALT-014** The dispatcher MUST implement bounded retry with backoff for timeouts, network failures, rate limiting, and retryable server errors. The durable effect ledger MUST expose pending, delivered, exhausted, and manual-retry states without claiming exactly-once receiver delivery.
- **ALT-015** Configuration MUST offer a synthetic **Send test notification** action and report HTTPS, CORS/connection, authentication, timeout, and response-status failures as specifically as the browser makes observable, without exposing response bodies that may contain secrets.
- **ALT-016** External alert payloads MAY include generic event kind (for example, new message or new thread reply), detection time, age, elapsed time, status, unseen-count, overdue/escalation stage, and stable non-content effect identifiers. These fields MUST remain non-content and MUST NOT be used to reconstruct a room, sender, message, or Matrix event.

#### Webhook and external-relay note

The webhook transport is intended for destinations such as [ntfy](https://docs.ntfy.sh/publish/), including a [self-hosted instance](https://docs.ntfy.sh/install/), home-automation software, or another operator-controlled relay. ntfy accepts HTTP publication and supports access-token authentication. A browser can only call an endpoint whose CORS policy permits the AckWatch origin, and the deployment Content Security Policy must also permit the destination. AckWatch MUST test and explain those conditions rather than treating a configured URL as healthy.

A successful webhook can move the alert to a phone, pager, or other more visible system after the browser publishes it. It does not extend Matrix monitoring beyond the browser lifecycle: if AckWatch is closed or suspended before detecting and dispatching an event, no webhook can be produced.

### 6.12 User interface

- **UI-001** The persistent health header MUST separately display account/homeserver, connection coverage, monitoring armed/off, last confirmed coverage, audio state, browser-notification state, and webhook state when configured.
- **UI-002** A healthy green monitoring state MUST require both armed monitoring and complete Matrix coverage.
- **UI-003** The main screen MUST separate Needs attention, Open work, and Completed history.
- **UI-004** Persistent faults MUST cover interruption/gap recovery, ingestion, crypto, storage, authorization, second-tab ownership, and configured alert-transport failures.
- **UI-005** Available actions MUST use the domain language: View details, Acknowledge, Review new activity, Complete, Reopen, and Open in Matrix.
- **UI-006** Opening item details marks it viewed; merely rendering an item does not.
- **UI-007 — Matrix event URI actions:** AckWatch MUST offer an **Open in Matrix** action and a separate **Copy Matrix URI** action using only the Matrix event URI (`matrix:`). AckWatch MUST NOT generate, display, or navigate to `matrix.to` links or any other web/external resolver. If the browser cannot open the URI, the copy action remains available and the UI MUST explain the local browser limitation.
- **UI-013 — Link actions do not view:** **Open in Matrix** and **Copy Matrix URI** MUST NOT mark an item viewed or acknowledged. Only opening the AckWatch detail view (per UI-006) or an explicit user action may change viewed/acknowledged state.
- **UI-008** UI behavior MUST be keyboard complete, screen-reader meaningful, non-color-dependent, reduced-motion aware, and resilient at supported desktop/mobile viewport widths.
- **UI-009** The UI MUST render Matrix/user content as text, never injected formatted HTML.
- **UI-010** When an item is opened in AckWatch, the detail view MUST show the complete decrypted textual message, room name, sender, timestamps, relation/thread context, and safe message metadata available to the client. It MUST not require the user to infer the item's identity from a generic label.
- **UI-011** The queue list SHOULD show room and sender labels plus a short Unicode-safe preview (not a byte-truncated broken string), message kind, age, and attention state. The preview is separate from the full detail view; V1's implementation default is approximately 160 Unicode-safe characters.
- **UI-012** Full detail MUST be resolved/decrypted on demand from the SDK/crypto stores and kept out of AckWatch workflow storage by default. After reload, logout, or a missing-key condition, the UI MUST clearly show when full detail is temporarily unavailable while retaining the queue item and short preview.

## 7. Privacy and security requirements

- **SEC-001** No analytics, third-party runtime scripts, remote fonts, CDN code, remote sounds, or telemetry MAY ship in V1.
- **SEC-002** Tokens, passwords, recovery keys, secret-storage keys, decrypted bodies, and raw authentication responses MUST NOT appear in logs or diagnostics.
- **SEC-003** Workflow storage MUST keep only length-limited plaintext previews by default, never formatted bodies or attachment bytes.
- **SEC-004** A privacy setting MUST support generic previews with no persisted plaintext body. Rich browser detail remains available only through the approved detail-resolution policy and MUST NOT be sent to external transports by default.
- **SEC-005** Diagnostics exports MUST be redacted by construction and previewed before download.
- **SEC-006** The production bundle MUST use an empirically tested restrictive Content Security Policy and no public production source maps unless handled as private artifacts.
- **SEC-007** Dependencies MUST be locked and audited. AGPL reference clients are study-only unless the project's license intentionally permits code reuse.
- **SEC-008** AckWatch MUST document that Matrix credentials are session-only, that an active token remains accessible to application JavaScript while the session runs, and that workflow/crypto storage is not a confidentiality boundary.
- **SEC-009** Webhook destinations MUST use HTTPS except for an explicit loopback development/test endpoint. The configuration screen MUST preview the exact privacy tier and destination origin before enabling delivery.
- **SEC-010** The tested Content Security Policy and deployment guidance MUST account for user-configured webhook origins without silently broadening unrelated resource directives.

## 8. Reliability and quality attributes

- **REL-001 Idempotency:** repeating the same accepted input sequence MUST produce the same durable state and effects.
- **REL-002 Ordering:** per-account ingestion MUST be serial and deterministic; recovered events precede buffered post-gap events.
- **REL-003 Crash consistency:** no committed activity may exist without its corresponding queue mutation/effect intent, and no queue mutation may count an uncommitted activity.
- **REL-004 Observability:** every dropped-looking event path MUST have an intentional ignore reason or ingestion issue.
- **REL-005 Recovery:** retryable gap, decryption, alert-effect—including webhook—and storage-open failures MUST survive ordinary reload where safe.
- **REL-006 Performance:** normal queue interactions SHOULD remain responsive with at least 10,000 stored activities and 1,000 queue items; exact budgets will be measured and recorded during qualification.
- **REL-007 Accessibility:** automated accessibility scans MUST report no serious/critical violations on gated screens, with keyboard flows tested separately.
- **REL-008 Testability:** time, notifications, audio, event source, credentials, lifecycle, ownership, and persistence MUST be replaceable through explicit boundaries.

## 9. Automated verification specification

### 9.1 Test layers

The project MUST maintain:

1. pure domain unit tests with a fake clock and effect collector;
2. component tests with React Testing Library and accessibility assertions;
3. persistence integration tests using fake IndexedDB and real browser IndexedDB where behavior differs;
4. Matrix adapter tests using sanitized scripted sync fixtures, including limited timelines;
5. Playwright browser/system tests against the built application;
6. real Matrix protocol tests against a required ephemeral local homeserver, with optional developer-provided test-homeserver compatibility runs;
7. webhook contract tests against a required controllable HTTP receiver and self-hosted ntfy test instance;
8. deterministic visual screenshot tests and a human-review gallery.

### 9.2 Real Matrix test roles and credentials

The unattended suite SHOULD use three disposable users:

- `MONITOR`: logs into AckWatch and receives room activity;
- `SENDER_A`: creates rooms, invites users, and sends activity;
- `SENDER_B`: supports group-room, ordering, thread, and concurrent-sender scenarios.

Two users are the minimum. Credentials MUST enter only through ignored environment files or CI secrets. Expected variable names will be documented during setup, including homeserver URL, user IDs, and passwords/access tokens. Tests MUST redact secrets and MUST fail safely when required integration credentials are absent.

### 9.3 Matrix scenario controller

An application-independent test controller MUST be able to:

- authenticate all fixture users;
- create uniquely named private rooms;
- invite the monitor and additional senders;
- accept/join invitations using an independent short-lived provisioning client whose local stores cannot overlap AckWatch's stores;
- send baseline and post-arm messages;
- send edits, redactions, thread roots/replies, notices, emotes, files/image metadata, and encrypted messages;
- wait for server acknowledgment and record event IDs;
- deliberately repeat inputs and vary ordering;
- leave/forget or label test rooms for later cleanup;
- produce a redacted machine-readable run manifest.

The controller MUST NOT reuse AckWatch's normalization/domain implementation as its oracle. Assertions MUST compare server-confirmed event IDs and independently constructed expectations with the application's visible/durable output.

### 9.4 Required unattended real-homeserver scenarios

- Create room, invite monitor, accept invite, send pre-arm baseline, launch/login, and prove baseline exclusion.
- Arm monitoring, post from `SENDER_A`, and prove one item/activity appears exactly once.
- Post from two senders in deterministic order and prove ordering and counts.
- Stop, post, synchronize baseline, rearm, and prove stopped-window exclusion.
- Create a room during the run, invite/join the monitor through fixture setup, then prove only eligible post-join/post-arm activity is captured.
- Create a thread and prove root/reply grouping; test root predating the session.
- Edit and redact tracked events and prove maintenance-without-new-alert semantics.
- Exercise encrypted text and encrypted thread traffic with durable placeholder/enrichment behavior.
- Reload and prove workflow restoration plus monitoring OFF.
- Open a second tab and prove exclusive ownership.
- Expire/invalidate a token and prove a visible fatal interruption.

Connection loss and truly limited server timelines MUST be tested deterministically with a scripted proxy/fixture and the local containerized homeserver's fault controls. A shared developer homeserver MAY receive additional compatibility runs, but it is not the source of the core deterministic guarantee.

### 9.5 Screenshot and visual review requirements

Playwright MUST create reviewable PNG screenshots from actual browser rendering for at least:

- signed-out/login;
- baseline syncing;
- ready but monitoring off;
- healthy armed monitoring with empty queue;
- new item and multiple-item queue;
- viewed/unacknowledged;
- acknowledged with new activity;
- overdue/escalated;
- completed history;
- reconnecting, recovering gap, and coverage incomplete;
- audio/notification fault;
- webhook disabled, healthy, retrying, and exhausted/faulted;
- encrypted placeholder/decryption failure;
- second-tab blocked;
- narrow/mobile and standard desktop viewports;
- keyboard-focus and reduced-motion modes where visually relevant.

Synthetic deterministic data SHOULD drive the full state catalog so screenshots do not depend on network timing. A smaller real-homeserver screenshot set MUST prove the integrated UI. The production build MUST exclude the fixture-state entry point. Screenshot artifacts MUST contain only synthetic test content and MUST be accompanied by an HTML/index or manifest showing browser, viewport, commit/worktree identifier supplied by the human workflow, and scenario.

Visual baselines MUST NOT be updated automatically after diffs. Codex may generate candidate images and a diff report; the human approves baseline replacement at a checkpoint.

### 9.6 Required reports

Each implementation gate MUST produce a machine-readable test result plus a concise human report containing:

- commands executed;
- versions and browser engines;
- automated pass/fail/skip totals;
- integration homeserver/server version without secrets;
- created test-room manifest and cleanup status;
- screenshot gallery/diff location;
- coverage or known limitations;
- exact reproduction commands for failures.

## 10. Human interaction and autonomy contract

After a plan phase is approved and implementation for that phase is authorized, Codex SHOULD proceed independently through all in-scope coding, formatting, tests, local fault diagnosis, browser runs, and documentation until the next defined checkpoint.

Human interaction is reserved for:

- approving this specification and implementation plan;
- providing secret credentials or external permissions unavailable to Codex;
- making product choices that materially change requirements;
- reviewing screenshot/behavior gates;
- executing all Git commits and pushes;
- authorizing the next implementation phase.

Codex MUST NOT run `git commit`, `git push`, create/publish a GitHub repository, or mutate GitHub state. At a checkpoint it MUST provide proposed commit message(s) and exact commands for the human to review and run.

## 11. Acceptance and release boundary

V1 is acceptable only when:

- every approved requirement above is implemented or explicitly deferred by a recorded specification amendment;
- all mandatory automated suites pass in the supported release environment;
- limited-gap failure cannot produce a healthy indicator;
- real Matrix automation proves room creation, invitation/join provisioning, baseline exclusion, post-arm capture, stop/rearm exclusion, threads, edits/redactions, encryption, reload, and single-instance behavior;
- generic and ntfy-compatible webhook automation proves private-by-default payloads, post-commit dispatch, durable retry, secret redaction, and visible failure health;
- screenshot and accessibility gates are human-approved;
- secrets do not appear in repository content or test artifacts;
- security/privacy/deployment documentation is complete;
- the remaining browser limitations are stated without overstating notification or closed-page guarantees.

## 12. Approval decisions

Specification version 1.3 and Phase 1 setup were approved by the developer on 2026-08-31.

The following decisions are resolved and locked:

- Product name **AckWatch** and descriptor **“A local-first attention monitor for Matrix.”**
- No prior CLI/product implementation exists; this specification is the sole behavioral authority.
- Project license: **Apache License 2.0** (`Apache-2.0`).
- V1 Matrix credential policy: **session-only credentials exclusively; no remembered-login mode**.
- V1 preview policy: **rich complete decrypted detail inside AckWatch; room/sender and a short preview in the in-browser list; generic metadata only for external alerts**.
- V1 detail persistence policy: **resolve full decrypted detail on demand; do not persist full decrypted bodies in AckWatch workflow storage**.
- V1 alert schedule defaults: **immediate initial/reopen; unacknowledged escalation at 5 minutes repeating every 5 minutes; acknowledged-work escalation at 30 minutes repeating every 15 minutes**.
- V1 settings persistence policy: **account-scoped local IndexedDB; retained across reload/restart/logout-login in the same browser profile when local data is retained; independent across browsers/profiles; no cross-device sync**.
- V1 gap-health policy: **strict degraded coverage; remain logically armed, but never show healthy/caught-up until gap recovery succeeds**.
- V1 Matrix link policy: **use Matrix event URIs only; offer separate open and copy actions; never use `matrix.to` or another external resolver; neither link action marks an item viewed or acknowledged**.
- V1 retention policy: **retain completed workflow history indefinitely with explicit manual cleanup; retain diagnostics and webhook-attempt records for 30 days by default, with a per-account configurable period**.
- V1 test-infrastructure policy: **the core unattended suite requires a disposable local Matrix homeserver plus local controllable webhook and self-hosted ntfy services; developer-provided remote accounts are optional compatibility coverage**.

The first human checkpoint MUST record decisions for the remaining setup items:

1. package manager and supported Node line;
2. authorization to begin controlled workspace setup.

No application implementation or environment initialization is authorized by approval of isolated wording changes. Approval MUST explicitly authorize the setup phase described in the implementation plan.
