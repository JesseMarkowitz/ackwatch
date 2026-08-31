# Matrix attention monitor research and design review

Status: research and planning only; no application code has been written  
Prepared: 2026-08-31  
Workspace at review time: empty apart from environment-owned placeholder directories; Git is not initialized

This document is non-normative background. The later [`SPECIFICATION.md`](./SPECIFICATION.md) supersedes any earlier recommendation here. In particular, AckWatch is the adopted name; credentials are session-only; browser detail is rich while external alerts are generic; Matrix links use event URIs only; completed history is retained indefinitely with manual cleanup; diagnostics/webhook-attempt retention defaults to 30 days and is configurable; and the required unattended integration foundation is a disposable local Matrix/webhook test stack with optional remote compatibility runs.

## Executive conclusion

The proposed product is feasible as a static React application using `matrix-js-sdk`, IndexedDB, and browser notification/audio APIs. The core product distinction—an explicit, local attention workflow rather than another Matrix read-state UI—is sound and worth preserving.

The specification is not yet safe to implement literally. Its principal weakness is that it equates “events emitted after START MONITORING” with complete delivery. Matrix incremental sync can return a limited timeline after an interruption and omit events in a gap. Event-ID deduplication prevents duplicates but cannot recover omitted events. The Matrix specification says clients must close that gap through `/rooms/{roomId}/messages`; the current JS SDK exposes timeline reset and forward-pagination facilities that can support this, but the monitor must orchestrate and test the recovery itself.

The first implementation gate should therefore be slightly stronger than the proposed Milestone 1:

1. Establish a network-confirmed baseline, not merely an SDK `PREPARED` state.
2. Arm monitoring only at a healthy sync boundary.
3. Capture ordinary incremental events exactly once.
4. Preserve logical monitoring through an ordinary reconnect.
5. Detect limited/gappy syncs, recover the gap, and refuse to claim “caught up” until recovery succeeds.
6. Prevent two tabs from opening the same Matrix crypto store.

With those corrections, the rest is mostly local workflow, transactional persistence, alert scheduling, and focused UI work. Without them, the application could look healthy while missing exactly the messages it exists to protect.

## Overall assessment of the supplied specification

### Strong parts to keep

- The product scope is disciplined: it is an attention queue, not a replacement chat client.
- Matrix read state, local workflow state, and new activity are correctly separated.
- Monitoring is explicitly armed after a baseline and is not inferred from historical unread state.
- Workflow logic is intended to remain outside React.
- SDK event objects are intended to stop at a normalization boundary.
- Event-ID deduplication, placeholder-on-decryption-failure, absolute alert deadlines, and focus/visibility catch-up are all correct reliability principles.
- Browser-first/platform-interface boundaries are appropriate for a later Tauri wrapper.
- The proposed fake clock, fake notifier, and fake event source create the right unit-test seams.
- The warning against copying client crypto code is important: use the SDK's Rust/WASM crypto implementation.

### Changes required before implementation

| Priority | Issue | Why it matters | Required resolution |
| --- | --- | --- | --- |
| Critical | Limited `/sync` responses can contain gaps | Events sent during an armed outage can be omitted from the returned timeline | Add gap detection, buffered recovery through `/messages`, and an explicit degraded state until recovery completes |
| Critical | `PREPARED` can come from IndexedDB cache | Clicking START after cached `PREPARED` can capture closed-window backlog as if it were new | Require a successful non-cache network sync with catch-up complete before enabling START |
| Critical | Multiple tabs can share one crypto IndexedDB | The SDK warns this can corrupt crypto state and cause decryption failures | Add an exclusive per-account/device instance lock and a clear secondary-tab screen |
| Critical | Event processing and dedup writes are not specified as one transaction | A crash or partial write can double-count or silently lose queue state | Make event acceptance, activity insertion, queue mutation, and alert-effect creation atomic |
| High | Late decryption, edits, and redactions are tied too closely to monitoring eligibility | Existing persisted items can become stale, and placeholders might never resolve after STOP | Process maintenance/enrichment updates for tracked records even when monitoring is off; only new-work creation is gated by the session |
| High | Thread-root promotion is unspecified | A root can arrive as an ordinary event and only later become a thread root | Use a stable internal queue-item ID plus a unique, mutable conversation key; atomically promote/merge when the first thread reply arrives |
| High | Workflow counters and “ack new activity” semantics are ambiguous | Implementations and tests will disagree about when counts clear and deadlines reset | Define explicit commands and deadline rules before Milestone 2 |
| High | Browser alert guarantees are overstated | Background throttling, autoplay policy, OS suspension, and tab termination prevent a hard audible guarantee | State browser alerts as best effort, continuously expose alert health, and reserve stronger guarantees for Tauri |
| Medium | Authentication/session restoration lacks a browser threat model | A static app has no HttpOnly server session and cannot securely persist a Matrix token against XSS | Make retention an explicit policy and user choice behind `CredentialStore`; document the limitation |
| Medium | Account identity is absent from workflow keys | A future second account can collide or force a difficult migration | Include `accountId` in all queue, activity, alert, session, and setting keys now, while still shipping single-account V1 |
| Medium | The milestone order postpones persistence and reconnect correctness | Reliability is being proved after UI investment | Pull basic reconnect/gap work into Milestone 1 and persistence ahead of the practical queue UI |

## Research basis

Research was performed against the following current sources on 2026-08-31:

- Matrix Specification v1.19, released 2026-07-08. The Client-Server API defines incremental sync, limited timelines, gap backfill, browser CORS, login, threads/relations, and redactions. [Matrix v1.19 release](https://matrix.org/blog/2026/07/08/matrix-v1.19-release/) and [Client-Server API v1.19](https://spec.matrix.org/v1.19/client-server-api/).
- `matrix-js-sdk` at commit [`aa1aeed`](https://github.com/matrix-org/matrix-js-sdk/tree/aa1aeed63b5ef0327f0442d63e31efca58df46b0), package version 42.2.0, Apache-2.0. The SDK officially supports browser bundlers including Vite and uses Rust/WASM crypto. [SDK documentation](https://matrix-org.github.io/matrix-js-sdk/) and [license](https://github.com/matrix-org/matrix-js-sdk/blob/develop/LICENSE).
- Weave at commit [`3ddc1f0`](https://github.com/fireshaper/Weave/tree/3ddc1f0df4e8c809defc50a4def018cabd505d58), a React/Vite/`matrix-js-sdk`/Tauri 2 client. Its current license is MIT. [Repository](https://github.com/fireshaper/Weave) and [license](https://github.com/fireshaper/Weave/blob/main/LICENSE).
- Sable at commit [`53fb361`](https://github.com/SableClient/Sable/tree/53fb3619025997ad284c4dd600fe783b7b0d5de2), a large production-oriented Matrix web/Tauri client using current `matrix-js-sdk`. It is AGPL-3.0-only and must remain study-only unless this project's license is intentionally compatible. [Repository](https://github.com/SableClient/Sable) and [license](https://github.com/SableClient/Sable/blob/dev/LICENSE).
- Browser platform documentation for storage persistence, audio/autoplay, notifications, lifecycle, and cross-tab coordination. See the source list at the end of this document.

Three shallow reference clones were used to search exact current source behavior and are retained under `.research-sources/` for follow-up work. Their commit IDs are recorded above. Because they are nested Git repositories, delete the directory or add it to the future parent repository's ignore rules before initializing/tracking the application repository.

## What the SDK research changes

### `PREPARED` does not necessarily mean “current with the homeserver”

The SDK's own `SyncState.Prepared` comment says the data can come from cache. Its startup flow loads a saved sync, marks it `fromCache: true`, and emits `PREPARED` before or alongside the first incremental network request. See [`sync.ts` lines 80-97](https://github.com/matrix-org/matrix-js-sdk/blob/aa1aeed63b5ef0327f0442d63e31efca58df46b0/src/sync.ts#L80-L97) and [`sync.ts` lines 700-781](https://github.com/matrix-org/matrix-js-sdk/blob/aa1aeed63b5ef0327f0442d63e31efca58df46b0/src/sync.ts#L700-L781).

Consequences:

- `client.isInitialSyncComplete()` or the first `PREPARED` alone is not a sufficient baseline gate.
- Cached timeline callbacks must not create work.
- START MONITORING should remain disabled until a later network `SYNCING` boundary whose sync data is not from cache and is no longer catching up.
- The UI should distinguish “restored local cache” from “caught up with homeserver.”

### `RoomEvent.Timeline` carries useful provenance

The SDK's room timeline callback includes `data.liveEvent`. It is true only for an event appended to the live timeline and not sourced from cache. See [`event-timeline-set.ts` lines 53-110](https://github.com/matrix-org/matrix-js-sdk/blob/aa1aeed63b5ef0327f0442d63e31efca58df46b0/src/models/event-timeline-set.ts#L53-L110) and [the assignment of `liveEvent`](https://github.com/matrix-org/matrix-js-sdk/blob/aa1aeed63b5ef0327f0442d63e31efca58df46b0/src/models/event-timeline-set.ts#L687-L699).

This is a better primary timeline feed than treating every `ClientEvent.Event` identically, because `ClientEvent.Event` also covers state, ephemeral, and account-data sections and can emit some events more than once. The normalization layer should still deduplicate all accepted events by event ID.

Recommended V1 source strategy:

- Use `RoomEvent.Timeline` for room-timeline ingestion.
- Require `toStartOfTimeline === false`, `removed === false`, and `data.liveEvent === true` for ordinary armed-session creation.
- Listen separately for `RoomEvent.TimelineReset`, redaction/update signals, and `MatrixEventEvent.Decrypted`.
- Route gap-backfilled events through an explicit recovery path; pagination events are not ordinary `liveEvent`s.
- Keep the SDK behind `MatrixEventSource` so a later SDK change does not leak into the queue engine.

### A successful reconnect can still be gappy

The Matrix spec explains that an incremental sync may return `timeline.limited: true`, omitting events between the previous `since` token and the returned `prev_batch`. The prescribed recovery is `/rooms/{roomId}/messages?from=<old sync token>&to=<prev_batch>`, and clients should deduplicate the result by event ID. [Matrix syncing and limited timelines](https://spec.matrix.org/v1.19/client-server-api/#syncing).

The JS SDK resets the live timeline on such a response and preserves forward/backward pagination tokens when timeline support is enabled. See [`sync.ts` limited-timeline handling](https://github.com/matrix-org/matrix-js-sdk/blob/aa1aeed63b5ef0327f0442d63e31efca58df46b0/src/sync.ts#L1345-L1402). Its public `paginateEventTimeline` method can fill a timeline in either direction. See [`MatrixClient.paginateEventTimeline`](https://matrix-org.github.io/matrix-js-sdk/classes/matrix.MatrixClient.html#paginateEventTimeline).

The monitor must not assume that the SDK automatically emits every omitted event through `ClientEvent.Event`; the SDK documents that this event is for live `/sync` data, not pagination. [ClientEvent.Event documentation](https://matrix-org.github.io/matrix-js-sdk/enums/matrix.ClientEvent.html#Event).

### Event listeners must never throw into the SDK

The SDK stores the new sync token before processing the response, explicitly so a processing failure does not loop forever on the same token. See [`sync.ts` lines 859-922](https://github.com/matrix-org/matrix-js-sdk/blob/aa1aeed63b5ef0327f0442d63e31efca58df46b0/src/sync.ts#L859-L922). A monitor listener that throws can therefore contribute to skipped local processing while the SDK advances.

Every SDK callback must be a non-throwing boundary. It should capture a minimal envelope and hand it to a serial ingestion service. Normalization failures must become visible/persisted ingestion issues or conservative placeholders, not exceptions escaping to the SDK.

### E2EE has a single-owner storage requirement

`initRustCrypto()` uses IndexedDB by default in a browser. The SDK warns that multiple Matrix clients connected to the same crypto database can corrupt data and cause decryption failures. [SDK E2EE initialization](https://matrix-org.github.io/matrix-js-sdk/#end-to-end-encryption-support) and [`initRustCrypto` API](https://matrix-org.github.io/matrix-js-sdk/classes/matrix.MatrixClient.html#initRustCrypto).

This makes a same-origin, per-account/device exclusive lock a production requirement, not an optional refinement. The browser [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) is designed for this cross-tab leader-election use case. A `BroadcastChannel` can provide friendly “already open in another tab” messaging but should not be the correctness lock by itself.

## Product guarantees and honest limitations

The web release should advertise these precise guarantees:

- While a page instance is alive, owns the account lock, has an armed monitoring session, and can eventually synchronize/backfill with the homeserver, every qualifying event observed in the live sync or recovered armed-session gap is accepted idempotently into local workflow storage or surfaced as an ingestion error.
- During a temporary network failure, monitoring remains logically armed. Connection coverage is degraded until catch-up and any gap recovery complete.
- Closing, reloading, browser tab eviction, browser process termination, or navigating the document away ends monitoring. Messages during the closed interval form the next baseline and do not become work automatically.
- Workflow items already committed to IndexedDB survive ordinary restart, subject to browser storage retention and explicit user clearing.
- Browser sound and desktop notifications are best effort. The application can detect and display many failures, but a web page cannot guarantee that an OS/browser will run or sound it while suspended.
- No browser-only design can provide an HttpOnly Matrix session token without a server. A remembered token is accessible to application JavaScript and therefore exposed by any successful XSS. This is a documented tradeoff, not something `CredentialStore` can cryptographically wish away.

For the intended “several hours of confidence” use case, the UI should continuously show four independent health indicators:

1. Matrix transport/sync coverage.
2. Monitoring armed/off.
3. Audio subsystem ready/faulted/muted.
4. Browser notification permission/availability.

A green monitoring indicator is allowed only when the first two are healthy. Audio or notification degradation must remain independently visible.

## Recommended lifecycle model

Connection and monitoring should not be represented by one boolean.

### Connection coverage states

- `signed_out`
- `starting`
- `cache_restored`
- `baseline_syncing`
- `ready`
- `reconnecting`
- `catching_up`
- `recovering_gap`
- `coverage_incomplete`
- `fatal_error`
- `stopped`

### Monitoring states

- `off`
- `armed`

Rules:

- START is enabled only in `ready`.
- START creates a new in-memory session ID and atomically records a session-start audit record if session history is enabled.
- STOP immediately sets monitoring to `off`; the SDK may keep syncing so the next START can use a clean current baseline.
- A transport failure changes connection coverage but not `armed`.
- While `armed` and disconnected, the header says `MONITORING INTERRUPTED`, not “monitoring active” in green.
- After reconnect, the UI stays in `catching_up`/`recovering_gap` until the ingestion queue and all required gap recovery have drained.
- `pagehide`, reload, teardown, logout, and loss of the instance lock disarm the session. Do not persist an auto-resume flag.
- Because unload hooks are unreliable, startup treats any previously recorded active session as abandoned/interrupted. Queue state is saved on every mutation, never at unload time. The [`beforeunload` event is only a warning aid](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event), not a persistence mechanism.

### Baseline rule

“Ready” means all of the following:

- SDK/cache initialization finished.
- At least one successful network `/sync` result has been fully processed after client startup.
- The result is not marked `fromCache`.
- SDK catch-up is false.
- The monitor's own ingestion queue is drained.
- No active limited-timeline recovery is outstanding.
- Crypto initialization succeeded if encrypted rooms are in supported scope.

This rule also applies before rearming after STOP if a reconnect/catch-up is in progress.

## Ingestion and gap-recovery design

### Delivery provenance

The application-owned envelope needs more than the original `IncomingActivity` example. Add these concepts:

- `accountId`
- `monitoringSessionId` when eligible
- `deliveryProvenance`: ordinary live sync, armed-session gap recovery, cached baseline, unarmed sync, context lookup, or enrichment update
- a local monotonically increasing `deliverySequence`
- `detectedAt` from the application clock
- `originServerTs` only as informational metadata
- content state: ready, waiting for decryption, deleted, or malformed
- relation metadata: thread root, replacement target, reply target, and redaction target where applicable

`origin_server_ts` must not decide monitoring eligibility or alert deadlines. A recovered event's alert deadline starts when the monitor detects it, because it could not alert during the outage.

### Normal path

1. The SDK listener captures event ID, room ID, wire type, sender, relation metadata, session/provenance, and local detection sequence without throwing.
2. The normalizer returns a supported activity, a tracked-record mutation, an intentional ignore decision, or a visible ingestion issue.
3. The filter runs outside React and after enough context is available.
4. The queue engine computes a deterministic state transition and requested effects.
5. One IndexedDB transaction inserts the unique activity, applies the queue mutation, and inserts unique alert-effect records.
6. Only after commit does the in-memory projection update and the alert dispatcher attempt effects.
7. Duplicate insertion returns “already handled” and produces no counter or alert effect.

Context lookup, decryption, room-name resolution, and thread-root fetching must not delay the initial placeholder commit.

### Limited/gappy path

1. While armed, `RoomEvent.TimelineReset` marks the affected room as gap-recovery-required and captures the old/new timeline boundary.
2. Newly returned live events for that room are buffered for queue ordering, though their IDs can be reserved immediately.
3. Use the SDK's retained old timeline and forward pagination to request the missing range until the old and new timelines join or the server indicates the boundary is reached.
4. Feed recovered events through the same normalizer with `armed_session_gap_recovery` provenance.
5. Process recovered events in server stream order, then the buffered events from the limited sync.
6. Deduplicate every step by account ID plus Matrix event ID.
7. If recovery fails, retain the buffer, retry with bounded backoff, show `COVERAGE INCOMPLETE`, and never show “caught up.” Provide a user-visible diagnostic/export path.
8. If the server cannot supply the gap, expose that the guarantee cannot be met. Never silently discard the condition.

This needs a deterministic integration test with a scripted `limited: true` response. A manual test that sends only a few messages during a short outage will usually not exercise the gap and is not sufficient evidence.

### Unarmed maintenance path

New-work eligibility and record maintenance are separate:

- While unarmed, ordinary new messages do not create queue items.
- A decryption success may enrich a previously tracked placeholder.
- An edit may update a tracked activity preview.
- A redaction may mark a tracked activity deleted.
- Thread-root context fetched for a tracked thread may update its title/context.
- None of these maintenance updates increments new-activity counters or emits a new-activity alert.

This preserves accurate persisted work without treating the unarmed interval as monitored work.

## Queue-domain clarifications

### Commands should be explicit

The queue engine should expose domain commands rather than writable status fields:

- accept new activity
- mark item viewed
- acknowledge item
- mark new activity reviewed
- complete item
- reopen item manually
- apply edit
- apply redaction
- enrich decrypted content
- promote/merge item into a thread
- evaluate overdue deadlines

React dispatches these commands and renders returned state; it does not implement transitions.

### Recommended counter semantics

- The first qualifying event creates `NEW` with `unseenActivityCount = 1` and total monitored activity count 1.
- Additional activity on `NEW` keeps `NEW` and increments unseen and total counts.
- `mark viewed` changes `NEW` to `UNACKNOWLEDGED`, sets `firstViewedAt` once, and clears the current unseen count/attention flag.
- New activity on `UNACKNOWLEDGED` retains the status, increments unseen and total counts, and sets `needsAttention`.
- `acknowledge` changes `NEW` or `UNACKNOWLEDGED` to `ACKNOWLEDGED`, records `acknowledgedAt`, and marks all currently known activity reviewed.
- New activity on `ACKNOWLEDGED` retains the status, increments unseen and total counts, and sets `needsAttention`.
- `mark new activity reviewed` clears unseen/attention without changing `ACKNOWLEDGED`.
- A new qualifying event on `COMPLETED` starts a new attention cycle, changes status to `NEW`, increments `reopenedCount`, clears `completedAt` from the active projection while preserving the transition history, and creates a new initial-alert effect.
- Edits, redactions, decryption updates, and context enrichment never increment the monitored-message count.

The suggested schema needs a separate `activityCount`; `unseenActivityCount` alone cannot power “thread has 4 monitored replies” after the user reviews them.

### Deadline semantics

- Unacknowledged due time is based on the first detected activity of the current attention cycle. Viewing does not postpone it.
- Acknowledged/pending due time is based on the most recent explicit transition into `ACKNOWLEDGED`.
- New activity does not silently change or postpone the acknowledged work deadline.
- Marking new activity reviewed also does not postpone the overall work deadline in the recommended default. If product owners want it to reset the 30-minute clock, that should be a named setting and tested explicitly.
- Completing cancels active deadlines.
- Reopening creates a new cycle with new deadlines and stage-effect IDs.
- Scheduler effects are keyed by item, attention cycle, and stage so a prior cycle's alert timestamp cannot suppress a reopened item's alert.

### Thread identity and promotion

Do not make the database primary key equal to `roomId + threadRootEventId`. Use:

- a stable, opaque local queue-item ID;
- a unique `conversationKey` scoped by account;
- `event:<roomId>:<eventId>` for an independent event;
- `thread:<roomId>:<threadRootEventId>` for a known thread.

When the first thread reply arrives:

1. Look for an existing item whose root event is that thread root.
2. If found, promote its conversation key and kind to thread.
3. If a thread item already exists because of a race or earlier unresolved reply, atomically merge the two.
4. Preserve all workflow transitions and activities; do not double-count or alert.

The thread reply itself must be queued immediately even if root fetch/decryption fails. Root resolution is enrichment. Ordinary `m.in_reply_to` replies must not be mistaken for `m.thread`; use the stable relation type and SDK public helpers where possible.

### Suggested persisted records

The exact TypeScript schema should be designed during Milestone 2/3, but these entities are recommended:

| Store | Key | Purpose |
| --- | --- | --- |
| `queueItems` | account ID + local item ID | Current workflow projection and deadlines |
| `activities` | account ID + Matrix event ID | Unique monitored events and tracked mutation events |
| `conversationKeys` | account ID + conversation key | Enforce one item per event/thread and support promotion |
| `workflowTransitions` | account ID + transition ID | Optional but recommended audit trail for reopen/history correctness |
| `alertEffects` | deterministic effect ID | Pending/delivered/failed effect ledger and one-shot escalation control |
| `settings` | account/global setting key | Thresholds, audio, notifications, filters, privacy choices |
| `monitoringSessions` | local session ID | Start/end/reconnect/gap diagnostics; never used to auto-resume |
| `ingestionIssues` | generated issue ID or event ID | Visible normalization/recovery failures that need retry or investigation |

All records should include a schema version where it materially aids migration. IndexedDB schema upgrades need automated migration tests.

For the wrapper, the small [`idb`](https://github.com/jakearchibald/idb) package is a good fit: it closely mirrors IndexedDB, is typed, and adds promises without introducing a larger reactive database framework. Dexie is also credible, but its larger abstraction is unnecessary unless live queries or more complex migrations become valuable. This choice should be finalized in Milestone 0.

## Matrix adapter plan

### Client creation and storage

- Use the SDK's browser entry point and documented public APIs.
- Give SDK sync storage, Rust crypto storage, and monitor workflow storage distinct database names.
- Namespace SDK stores by account/user and Matrix device ID.
- Create at most one live client per crypto-store namespace.
- Acquire the exclusive instance lock before opening SDK stores or initializing crypto.
- Start the IndexedDB sync store as documented before starting the client. [`IndexedDBStore`](https://matrix-org.github.io/matrix-js-sdk/classes/matrix.IndexedDBStore.html).
- Call `initRustCrypto()` before `startClient()` in the encrypted-room milestone.
- Enable `timelineSupport` because retained old timelines and pagination are needed for gap recovery.
- Install all non-throwing listeners before `startClient()`.
- Use a small or zero initial timeline limit for a first-time baseline, then test that current room/encryption state remains sufficient. Do not install an incremental filter that can exclude redactions or relationship events needed for correctness.
- Lazy-load members to control initial-sync size, but do not require a complete member list to accept an event.

### Authentication

- Validate/normalize the homeserver URL and require HTTPS except for explicit localhost development.
- Support Matrix `.well-known` discovery from a full MXID where practical, while retaining an advanced explicit homeserver field. The Matrix spec describes discovery and CORS requirements for browser clients. [Web clients and discovery](https://spec.matrix.org/v1.19/client-server-api/#web-browser-clients).
- Query `loginFlows()` and show password login only when `m.login.password` is offered.
- Use `loginRequest()` rather than the older mutating `login()`/`loginWithPassword()` helpers, which the current SDK marks deprecated. [`loginRequest` documentation](https://matrix-org.github.io/matrix-js-sdk/classes/matrix.MatrixClient.html#loginRequest).
- Ask for a refresh token when supported and build token rotation into the credential boundary; otherwise an expiring token can stop monitoring mid-session. [Matrix refresh endpoint](https://spec.matrix.org/v1.19/client-server-api/#post_matrixclientv3refresh).
- Never persist the password.
- Handle `M_UNKNOWN_TOKEN` as a prominent monitoring failure and transition to signed-out/re-auth-required.

### Browser credential policy

A static browser app cannot set an HttpOnly cookie for a third-party Matrix homeserver session. OWASP advises against storing authentication tokens in browser-accessible local storage/IndexedDB because XSS can read them. [OWASP HTML5 storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#storage-apis).

Recommended policy:

- `CredentialStore` should implement the V1 session-only policy. A remembered-token mode is outside the approved V1 scope.
- If a remembered mode is considered in a future version, explain that the token would be protected by same-origin browser storage, not an OS keychain and not against XSS/local profile access; it is not part of V1.
- Keep all third-party scripts, analytics, and runtime CDN dependencies out of the origin.
- A future Tauri `CredentialStore` uses the platform keychain/stronghold-style storage and can make remembered login the normal default.
- Logout stops the client first, releases the lock, invalidates the server token, and clears session/sync/crypto stores. Separately ask whether local workflow history should be retained or erased; do not conflate logout with destroying work records.

### E2EE behavior

- Use SDK Rust crypto only.
- Commit an encrypted placeholder as soon as the wire event is accepted. Do not wait for decryption before creating the queue activity.
- Trigger/await `decryptEventIfNeeded()` as enrichment and listen for `MatrixEventEvent.Decrypted`, which fires on both success and failure. [Decryption event documentation](https://matrix-org.github.io/matrix-js-sdk/enums/matrix.MatrixEventEvent.html#Decrypted).
- On failure, retain the placeholder and a non-secret reason code; retry when keys/backups/device verification change.
- On later success, update the existing event by event ID without emitting a second new-activity alert.
- Implement the public `CryptoApi` paths for verification, secret storage, and key backup required for a normal device. Do not reach into private `olmMachine` fields copied from clients.
- Crypto initialization failure is not a warning to swallow. Monitoring encrypted rooms must either be disabled with a prominent error or operate with durable placeholders and explicit “content unavailable” health; it must never silently pretend E2EE works.
- Test refresh/reload with the same device and persistent crypto DB, key backup recovery, verification, unknown sessions, withheld keys, and logout cleanup.

## Event semantics plan

### Initial supported activities

Qualifying V1 events should be narrowly enumerated:

- incoming `m.room.message` with `m.text`, `m.notice`, or `m.emote` content;
- image and file message types, represented by safe text metadata/filename rather than downloaded content;
- the encrypted wire form of the above, initially represented as waiting for decryption;
- stable Matrix thread replies grouped by root.

Everything else receives an explicit decision: supported activity, tracked mutation, intentional ignore, or unsupported diagnostic. Avoid a default branch that silently discards a plausible message.

### Self-authored events

Self-authored new messages do not create work. Keep their event IDs out of the queue but allow a future response detector to observe them through a separate feature. Local echoes must never create queue work; only server-confirmed events with real IDs are candidates.

### Edits

- Detect `m.replace` and its target.
- If the target activity is tracked, update a plain-text preview and `edited` flag.
- Keep the edit event ID as an idempotent tracked mutation so repeated delivery cannot reapply effects.
- If the target is untracked, ignore with a debug decision in V1.
- Do not increment activity counts, reopen, or alert.

### Redactions

- Resolve the redaction target using SDK public accessors/spec fields.
- Mark a tracked record as deleted and replace its preview with a local tombstone.
- Preserve the queue item and activity audit record.
- If the deleted record supplied the latest preview, recompute from the latest remaining tracked activity or show the tombstone.
- Do not decrement historical activity counts or alert.

### Thread roots

- Prefer relation data already available on the event/SDK.
- Fetch a missing root with the public room-event/context APIs and decrypt it when possible.
- Root content is context only unless the root itself was accepted during an armed session.
- Root fetch failure updates context status but never suppresses the reply.
- A root predating the session must not be counted as monitored activity.

## Persistence and privacy

### Transactional rule

For every accepted Matrix event, the following are one transaction:

- unique event/activity insertion;
- queue-item create/update/promotion/reopen;
- workflow timestamps/counters/deadlines;
- deterministic alert-effect insertion;
- removal or resolution of any corresponding ingestion placeholder.

The unique activity key decides whether the transaction is new. Alert dispatch happens after commit. This gives crash-safe queue state and makes repeated `processEvent` calls idempotent.

External sound/notification delivery cannot be transactionally exactly-once with IndexedDB. The effect ledger can provide best effort: unique effect IDs, pending/delivered/failed status, and notification `tag`s. The documentation should acknowledge the small crash window in which an external alert could be duplicated or not delivered even though the queue state is safe.

### Storage durability

IndexedDB is normally best-effort storage and may be evicted under storage pressure. Request persistent storage through `navigator.storage.persist()` after an explanatory user action and show whether it was granted. [Storage persistence](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist) and [quota/eviction behavior](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

The app should also:

- show a fatal workflow-storage error instead of continuing in memory unnoticed;
- expose storage usage/health in diagnostics;
- provide explicit export and clear-storage actions before release hardening;
- test quota errors, blocked upgrades, private browsing/storage denial, and schema migration failures;
- validate all IndexedDB records on read because local data can be corrupt or modified.

### Plaintext minimization

- Store a short, length-limited plain-text preview only; do not persist formatted HTML.
- Store filenames/media type, not attachment bytes, for image/file messages.
- Never store full raw decrypted events in workflow storage by default.
- If an ingestion retry needs raw material, prefer the encrypted wire event or a minimal sanitized envelope.
- Render previews as text through React escaping; never inject `formatted_body`.
- Add a setting to disable plaintext previews entirely, producing generic encrypted/private descriptions.
- Keep account tokens, recovery keys, and secret-storage keys out of workflow records, logs, diagnostics, and exports.

## Alert and scheduler design

### Scheduler

- The scheduler owns one periodic wake-up, not one timeout per item.
- It queries absolute due times through the queue repository.
- It runs on startup, interval, `visibilitychange`, `focus`, and `pageshow`.
- It inserts or claims deterministic one-shot alert effects before dispatch.
- It uses the injected `Clock` everywhere in domain/scheduler code.
- Sleep or timer throttling causes a late alert to fire immediately on the next scheduler pass.

### Web audio

- Bundle short audio assets with the build.
- During START, create/resume the audio context inside the click gesture and play a short audible test/confirmation when enabled.
- Treat a rejected play/resume promise or a non-running context as an alert-system fault and show it persistently.
- Recheck state during alert attempts; do not assume one successful unlock lasts forever.
- Offer mute/volume controls without masking monitoring state.

Browsers generally block audible autoplay without user interaction, and background policies vary. [MDN autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay) and [Web Audio best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices).

### Browser notifications

- Request permission only from an explicit user gesture.
- Treat denied/default/unsupported states as non-fatal but visible.
- Desktop `Notification` is supplemental; the active queue and audio remain primary.
- Use deterministic tags where supported to limit duplicate notifications.
- Do not imply notifications work after the page is closed; there is no push service in V1.
- Mobile browsers may require service-worker notifications and differ from desktop. [Notifications API guidance](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API).

## UI plan

The main screen should optimize for triage, not chat. Recommended regions:

1. Persistent health header with homeserver/account, connection coverage, monitoring state, last successful coverage time, audio state, and notification state.
2. `Needs attention` section for overdue unacknowledged, acknowledged-with-new-activity, new, and viewed-but-unacknowledged items.
3. `Open work` section for acknowledged overdue and acknowledged normal items.
4. Completed history/filter.
5. Persistent fault banner for connection interruption, gap recovery, ingestion issues, crypto problems, storage failures, or second-tab lock.

Actions should use domain language:

- View details
- Acknowledge
- Review new activity
- Complete
- Reopen
- Open in Matrix

Opening details marks an item viewed; merely expanding unrelated UI or rendering it in a list does not.

For “Open in Matrix,” use a standards-based `matrix:` event URI and provide a separate copy action. The approved product policy does not generate or navigate to `matrix.to` or another external resolver; this section's earlier fallback discussion is superseded by the specification.

Accessibility requirements belong in the initial UI milestone: semantic sections, keyboard-complete actions, focus management, non-color urgency indicators, reduced-motion support, readable elapsed/deadline text, and ARIA live announcements that do not repeatedly spam updates.

## Platform boundaries

Keep these boundaries, adding one that the original proposal lacks:

- `MatrixEventSource`: normalized timeline, sync coverage, gap-recovery, and enrichment events.
- `QueueRepository`: transactional application workflow persistence, not just CRUD.
- `Notifier`: new activity and escalation effects.
- `Clock`: current time and test control.
- `CredentialStore`: session credentials with explicit browser/Tauri security behavior.
- `ApplicationLifecycle`: visibility, focus, pagehide, close warning, later tray/background behavior.
- `InstanceCoordinator`: exclusive account/device ownership and cross-window status.
- `ActivityFilter`: pure filter policy using normalized activity/context.

These are application boundaries, not a generic plugin framework. React consumes projections and commands from application services.

## Source layout recommendation

The proposed layout is good. Adjust it to make lifecycle, ingestion, and transactional effects visible:

```text
src/
  app/                 composition root and application services
  matrix/              auth, client lifecycle, event source, normalization,
                       decryption enrichment, thread context, gap recovery
  queue/               domain types, commands, transitions, sorting, filters
  persistence/         database schema/migrations and transactional repository
  alerts/              scheduler, effect dispatcher, web notifier, audio health
  platform/            clock, credentials, lifecycle, instance coordinator
  state/               UI-facing projections/subscriptions only
  components/
  pages/
tests/
  fixtures/            sanitized Matrix sync/event fixtures
  unit/
  integration/
  browser/
docs/
public/sounds/
```

The composition root is the only place that should know concrete implementations such as IndexedDB, browser audio, or `matrix-js-sdk` adapters.

## Testing strategy

### Domain unit tests

Use plain Vitest with `FakeClock` and `FakeNotifier`/effect collector. Cover the supplied transition cases plus:

- initial unseen count is one;
- mark-viewed clears current unseen count without acknowledging;
- new activity on viewed/unacknowledged sets attention without changing status;
- direct acknowledge from NEW;
- direct complete from every allowed state;
- reopened cycles get fresh deadlines and alert IDs;
- new activity on acknowledged does not reset pending deadline;
- review-new-activity does not complete or change acknowledged status;
- edit/redaction/decryption updates do not increment counts or alert;
- thread promotion and racing merge preserve one item;
- sorting is stable when two items share timestamps;
- malformed commands fail deterministically without partial mutation;
- applying the same input sequence twice yields the same state and effects.

### Persistence integration tests

Use `fake-indexeddb` or a real browser IndexedDB test as appropriate:

- atomic event/activity/item/effect commit;
- unique event insertion under concurrent duplicate calls;
- transaction rollback on injected failure;
- reload restoration of every status;
- schema upgrades from every released version;
- blocked/terminated database behavior;
- queue item thread promotion/merge in one transaction;
- failed alert effect retry without duplicate domain effects;
- corrupted record quarantine and visible error.

### Matrix adapter tests

Use sanitized raw `/sync` fixtures and SDK test utilities only in tests. The SDK exposes a documented test entry point but it must not enter production code. [SDK entry points](https://matrix-org.github.io/matrix-js-sdk/#entry-points).

Required scripted cases:

- first-time initial sync, no historical activity emitted;
- cached sync emits callbacks and `PREPARED`, but START remains unavailable;
- first non-cache network sync completes baseline;
- one event after START produces one normalized activity;
- duplicate copies in state/timeline or repeat sync produce one activity;
- STOP excludes subsequent messages;
- restart restores queue but remains unarmed;
- reconnect without a limited timeline catches up all events;
- limited timeline produces a gap, backfills missing events, then drains buffered events in order;
- failed gap backfill remains `coverage_incomplete` and never reports caught up;
- pagination/context/root fetch cannot accidentally create new work;
- listener/normalizer exceptions do not escape the SDK callback;
- local echo and self-authored server event are ignored as new work;
- encrypted event creates a placeholder before decryption finishes;
- failed then successful decryption updates one activity;
- edit, redaction, reaction, membership, receipt, typing, and presence decisions.

### Browser tests

Add Playwright when browser behavior becomes material, even though core unit/UI testing remains Vitest/React Testing Library:

- Vite production build loads from static hosting and a subpath configuration;
- IndexedDB survives reload;
- second tab cannot own the same account lock;
- page reload always returns monitoring to OFF;
- background/focus overdue catch-up;
- audio unlock success and simulated play failure;
- notification granted/denied/unsupported UI;
- beforeunload listener exists only while armed;
- CSP does not block the SDK WASM, workers/assets, or homeserver requests;
- Chromium and Firefox gates; Safari manual/automated coverage where available.

### Real Matrix test environment

Use a test-only local homeserver (for example, containerized Synapse) and two disposable accounts. This does not violate the static-production requirement; it is development infrastructure. Keep secrets out of the repository.

Manual/E2E scenarios:

- unencrypted two-account baseline and stop/start;
- E2EE text, file metadata, thread reply, reload, verification, and key backup;
- network offline while the second account continues sending;
- enough scripted traffic to force or simulate a limited response;
- expired/invalid token during an armed session;
- storage denied/quota failure;
- browser sleep/background throttling;
- logout and selective workflow-history retention.

Never claim a real-homeserver or browser behavior was verified from unit mocks alone.

## Revised implementation milestones

The following sequence preserves the intent of the supplied milestones but moves foundational reliability forward.

### Milestone 0 — Foundation and decisions

Deliver:

- React, TypeScript, Vite, Vitest, React Testing Library, strict type checking, formatting/linting, static shell.
- Architecture decision records for project license, package manager/runtime versions, IndexedDB wrapper, token-retention default, preview privacy, and acknowledged-deadline semantics.
- Empty boundary interfaces including the added `InstanceCoordinator`.
- Test helpers and one real test.
- Dependency/license inventory and an explicit rule that AGPL sources are study-only unless the project license decision changes.

Gate:

- tests, typecheck, lint, and build pass;
- `dist/` is self-contained;
- no Matrix connection behavior is implemented yet.

### Milestone 1A — Authentication and network-confirmed baseline

Deliver:

- homeserver validation/discovery and advertised password login flow;
- session-only credentials first;
- SDK sync IndexedDB store;
- visible cache/baseline/ready/sync status;
- exclusive instance lock;
- START/STOP with in-memory monitoring session;
- developer event ledger for unencrypted qualifying messages;
- monitoring remains unavailable after cached `PREPARED` until a non-cache network sync completes.

Gate:

- old initial/cache messages never enter the ledger;
- each post-START external message enters once;
- self events and protocol noise do not;
- post-STOP messages do not;
- reload is unarmed;
- second tab is safely rejected/read-only, not connected to the crypto/sync stores.

### Milestone 1B — Reconnect and gap-complete event source

Deliver:

- reconnect/catch-up states;
- `RoomEvent.TimelineReset` detection;
- armed-session gap buffering and forward backfill;
- explicit `coverage_incomplete` state and diagnostics;
- deterministic duplicate suppression across sync and pagination.

Gate:

- ordinary outage catch-up emits all messages once;
- scripted limited sync emits missing and returned messages once and in order;
- failed backfill never displays healthy/caught-up state.

This is the real foundation gate. Do not invest in the queue UI until it passes.

### Milestone 2 — Pure queue domain

Deliver the statuses, commands, cycles, counters, deadlines, effects, sorting, thread promotion/merge, fake clock, and exhaustive unit tests. No Matrix, React, or IndexedDB imports are allowed in the domain package.

### Milestone 3 — Transactional workflow persistence

Deliver versioned IndexedDB stores and the atomic repository. Connect the event-source proof to durable activity/item/effect writes while retaining a simple developer view. Monitoring remains OFF after reload.

This intentionally moves the original persistence milestone ahead of the practical UI: lossless local acceptance is more foundational than presentation.

### Milestone 4 — Basic attention queue UI

Deliver active/completed views, health header, actions, age/deadline presentation, faults, and Open in Matrix. Use React Testing Library for user-visible behavior.

### Milestone 5 — E2EE and session hardening

Deliver Rust crypto initialization, durable device stores, placeholders, retry/enrichment, secret storage/key backup/device verification flows, refresh-token handling, logout cleanup, and E2EE real-server tests.

### Milestone 6 — Full V1 event semantics and threads

Deliver text/file/image normalization, stable thread grouping/root enrichment, edit/redaction maintenance, reaction/noise suppression, and promotion/merge behavior against real fixtures.

### Milestone 7 — Alerts and escalation

Deliver effect ledger, centralized scheduler, bundled audio, alert-health reporting, browser notifications, absolute deadlines, and focus/visibility catch-up.

### Milestone 8 — Reliability qualification

This milestone should now be a fault-injection and release gate, not the first reconnect implementation. Exercise long outages, limited gaps, repeated events, decryption delays, browser sleep, storage failures, token expiry, malformed events, and app restart. Publish a test report and clearly list any remaining guarantee boundaries.

### Milestone 9 — Filters and preferences

Add persisted filters only after the all-joined-rooms path is reliable. Each filtered event should still result in an explainable debug decision. Space membership and DM classification should be adapter context, not React logic.

### Milestone 10 — Web release hardening

Deliver static hosting docs, supported browsers, CSP, HTTPS/CORS troubleshooting, storage persistence/clear/export, privacy docs, no analytics/remote assets, dependency audit, beforeunload/page lifecycle behavior, and a production manual-test record.

### Milestone 11 — Tauri 2

Add native implementations for notifier, credential store, lifecycle, instance ownership, tray/background behavior, and deep-link opening. Reuse the same Matrix adapter, queue domain, repository semantics, scheduler rules, and tests. Re-evaluate database paths and single-instance behavior for native multi-window operation.

### Milestone 12 — Cross-device workflow design only

Produce a conflict-resolution design before code. Custom account data has concurrent-write, merge, retention, and privacy implications. Sync IDs/status/timestamps, not decrypted bodies. This remains optional.

## First proof: exact manual procedure

The initial proof should explicitly state that it covers unencrypted rooms until Milestone 5.

1. Start with a clean browser profile and two disposable Matrix accounts.
2. Log in to the monitor account.
3. Confirm the UI progresses through initial/baseline sync and does not enable START on cache-only readiness.
4. Confirm no historical timeline message appears in the monitored ledger.
5. Click START; verify audio initialization status even though full alerts come later.
6. Send two messages from the second account; verify two ledger records with distinct event IDs and no duplicates.
7. Send a message from the monitor account; verify no incoming-work record.
8. Click STOP, send another external message, and verify it is absent.
9. Wait for the SDK to catch up, click START again, and verify the stopped-period message remains baseline/absent.
10. Disconnect the monitor network while still armed, send several messages from the second account, reconnect, and verify each appears once.
11. Run the scripted limited-sync test and verify the omitted gap message is backfilled before coverage returns to healthy.
12. Reload the page, confirm existing durable records are restored once persistence exists, and confirm monitoring is OFF.
13. Open a second tab for the same account and confirm it cannot start another Matrix client against the same store.

Record homeserver/server version, SDK version, browsers, exact outcomes, and whether the limited response was real or scripted.

## Security and deployment checklist

- HTTPS in production; allow explicit HTTP only for localhost development.
- Homeserver must satisfy Matrix browser CORS behavior. [Matrix web-browser client requirements](https://spec.matrix.org/v1.19/client-server-api/#web-browser-clients).
- No analytics, Sentry, remote fonts, CDN scripts, or external sounds.
- No dynamic HTML rendering for previews.
- No tokens, passwords, recovery keys, access-token query strings, decrypted bodies, or raw auth responses in logs.
- Production source maps disabled or handled as private build artifacts.
- One dedicated origin for this application; do not co-host unrelated scripts that share browser storage.
- Restrictive CSP tested against the actual production bundle. Expect at least `default-src 'self'`, narrow style/font/image/media sources, `connect-src` sufficient for user-selected HTTPS homeservers, and the minimum directive needed for Rust crypto WASM. Do not publish an untested copy-paste CSP.
- `frame-ancestors 'none'`, `base-uri 'none'`, and `object-src 'none'` unless a tested requirement proves otherwise.
- Review whether Vite/SDK workers require `worker-src 'self'` or `blob:`; allow only what the built app uses.
- Sanitize and validate Matrix/user-provided names even when React escapes them.
- If any future external navigation is added outside V1, use `rel="noopener noreferrer"`; V1's Matrix action is URI-only and has no web fallback.
- Dependency versions locked; update SDK deliberately with adapter regression tests.
- Browser storage persistence requested and status visible.
- Clear-storage action separately covers workflow, SDK sync, crypto, and credentials with explicit user choices.
- Diagnostics exports are redacted by construction and previewed before download.

## Historical decision prompts

The prompts below were open when this research review was written. They are resolved by the normative specification and are retained only to explain the design trail. Remaining setup choices are tracked in the implementation plan's Checkpoint 0.

1. Project license — resolved as Apache-2.0.
2. Browser login retention — resolved as session-only.
3. Plaintext/detail privacy — resolved as rich in-browser detail and generic external alerts.
4. Pending deadline behavior — resolved; reviewing new activity does not reset the acknowledged-work deadline.
5. Gap guarantee — resolved as strict degraded coverage.
6. Open-in-client behavior — resolved as Matrix event URI only, with separate open/copy actions and no `matrix.to`.
7. Completed-history retention — resolved as indefinite local history with manual cleanup; diagnostics/webhook attempts default to 30 days and are configurable.

## Reference-project conclusions

### `matrix-js-sdk`

Use as the dependency and primary implementation authority. It provides the browser/Vite support, sync state, timeline events, pagination, login APIs, Rust crypto, thread models, and decryption events required. Keep all direct SDK usage inside `src/matrix/` and pin/upgrade it deliberately.

### Weave

Useful because it now closely matches the future stack: React, Vite, TypeScript, `matrix-js-sdk`, Rust/WASM crypto, IndexedDB, Tauri 2, native notifications, tray, and OS keychain. Its current MIT license permits reuse with attribution if desired.

Use it to study:

- Vite/WASM/Tauri packaging;
- distinct SDK sync and Rust crypto database naming;
- Tauri notification/tray/keychain capabilities;
- late-decryption UI updates.

Do not copy these weaker patterns:

- direct Tauri imports inside otherwise shared application services;
- the deprecated mutating login helper;
- treating initial `PREPARED` alone as the baseline;
- catching crypto initialization failure and continuing without a firm encrypted-room health contract.

### Sable

Useful as a production-behavior reference, especially for:

- explicit prevention of duplicate clients owning one crypto store;
- session-specific store naming and sync-store restart tests;
- token refresh and OIDC evolution;
- notification transport boundaries;
- visibility/network recovery and extensive browser/Tauri testing.

It is AGPL-3.0-only. Study behavior and public protocol/SDK usage, but do not transplant code unless the project's licensing decision intentionally allows it. It is also a general-purpose client with many dependencies and features that AckWatch should not adopt.

### Element Web, Hydrogen, and Cinny

These can answer isolated production-behavior questions, but their current licensing and full-client scope make them poor templates for this small application. Consult only when the Matrix spec/SDK and the two closer references do not answer a question.

## Source list

### Matrix

- [Matrix Specification v1.19 Client-Server API](https://spec.matrix.org/v1.19/client-server-api/)
- [Matrix URI and matrix.to appendices](https://spec.matrix.org/v1.19/appendices/#uris)
- [`matrix-js-sdk` documentation](https://matrix-org.github.io/matrix-js-sdk/)
- [`ClientEvent` sync and event documentation](https://matrix-org.github.io/matrix-js-sdk/enums/matrix.ClientEvent.html)
- [`RoomEvent.Timeline` handler shape](https://matrix-org.github.io/matrix-js-sdk/types/matrix.RoomEventHandlerMap.html)
- [`IndexedDBStore` documentation](https://matrix-org.github.io/matrix-js-sdk/classes/matrix.IndexedDBStore.html)
- [`MatrixEventEvent.Decrypted`](https://matrix-org.github.io/matrix-js-sdk/enums/matrix.MatrixEventEvent.html#Decrypted)
- [`CryptoCallbacks`](https://matrix-org.github.io/matrix-js-sdk/interfaces/crypto-api.CryptoCallbacks.html)
- [`matrix-js-sdk` Apache-2.0 license](https://github.com/matrix-org/matrix-js-sdk/blob/develop/LICENSE)

### Reference clients

- [Weave](https://github.com/fireshaper/Weave) and [MIT license](https://github.com/fireshaper/Weave/blob/main/LICENSE)
- [Sable](https://github.com/SableClient/Sable) and [AGPL-3.0-only license](https://github.com/SableClient/Sable/blob/dev/LICENSE)
- [Element Web](https://github.com/element-hq/element-web)
- [Hydrogen Web](https://github.com/element-hq/hydrogen-web)
- [Cinny](https://github.com/cinnyapp/cinny)

### Browser and build platform

- [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
- [Broadcast Channel API](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API)
- [Storage persistence](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
- [Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [Autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
- [Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)
- [`beforeunload` limitations](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)
- [Vite static deployment](https://vite.dev/guide/static-deploy)
- [Vite production build and base paths](https://vite.dev/guide/build)
- [`idb` IndexedDB wrapper](https://github.com/jakearchibald/idb)
- [OWASP HTML5 storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#storage-apis)

## Final recommendation

Proceed, but treat Milestone 1B as mandatory and gating. The architecture should be organized around coverage provenance and transactional event acceptance, not around React views. Implement an unencrypted proof first, demonstrate cache-safe baseline behavior plus complete reconnect/gap recovery, then build the pure queue domain and durable repository. Only after those gates should the project invest in practical UI, E2EE enrichment, and alerts.

That order best matches the product's defining promise: an unattractive but honest “coverage incomplete” state is acceptable; a polished green monitor that may have skipped an event is not.
