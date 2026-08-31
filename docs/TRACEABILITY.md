# Gate requirement traceability

This matrix maps the Gate 2 requirement families to executable evidence. “Phase 2 slice” means the
requirement is proven to the extent scheduled by the approved implementation plan; later-phase
semantics are called out rather than reported as complete.

| IDs          | Phase 2 evidence                                                                     | Result / boundary                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-001–003 | `authentication.test.ts`, `app-controller.test.ts`, local Matrix controller          | Full MXID discovery/override, advertised password flow, and one-use password handling pass.                                                 |
| AUTH-004–005 | `session-credential-store.test.ts`, `authentication.test.ts`, runtime token rotation | Session-only credentials and refresh-token request/rotation pass.                                                                           |
| AUTH-006–007 | `coverage.test.ts`, controller/runtime logout paths                                  | Authorization loss disarms; owned clients remotely log out and clear stores, while blocked tabs clear their local session.                  |
| LOCK-001–004 | `web-lock-coordinator.test.ts`, `app-controller.test.ts`, local second-tab scenario  | Lock precedes runtime/store construction; denial blocks startup; ownership loss is fatal.                                                   |
| SYNC-001–003 | `coverage.test.ts`, scripted sync fixture, local baseline scenario                   | Cached PREPARED cannot arm; network sync plus empty ingestion establishes ready; Start is gated.                                            |
| SYNC-004–007 | scripted sync tests and local stop/reload scenarios                                  | Stop is immediate, reconnect retains intent without healthy status, reload is unarmed, and backlog is excluded.                             |
| GAP-001–003  | runtime reset listener and `gap-recovery.test.ts`                                    | Reset detection, affected-room buffering, backward pagination, and chronological recovery pass.                                             |
| GAP-004–006  | gap/ingestion tests and `coverage-issue-repository.test.ts`                          | One serial idempotency path, durable manual retry across reload, incomplete health, and injected detection time pass.                       |
| ING-001–003  | `ingestion.test.ts`                                                                  | Callback exceptions are contained; provenance gating and four-outcome normalization pass.                                                   |
| ING-004–005  | normalization contracts                                                              | Initial intake does no context/media lookup and retains raw relation/content data. Decryption enrichment is explicitly deferred to Phase 4. |
| ING-006–007  | ingestion, gap, scripted sync, and local Matrix tests                                | Duplicate recovered/live IDs count once; self-authored activity is excluded.                                                                |

The machine-readable Gate 2 report repeats the exact IDs and evidence groups in
`artifacts/reports/gate2-summary.json` after `npm run check:gate2`.

## Phase 3 workflow alpha

| IDs                        | Gate 3 evidence                                                                                                                                   | Result / boundary                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QUE-001–004                | `queue.test.ts`, `workflow-repository.test.ts`, local Matrix thread scenario                                                                      | Opaque identities, unique conversation keys, and root/reply promotion in either arrival order preserve one item, all activities, transitions, and one pending effect.                                            |
| QUE-010–020                | exhaustive command table and generated invariant replay in `queue.test.ts`; repository rejected-command test                                      | Every state/command pair, cycles, counts, maintenance, deterministic failure, and no partial persistent mutation pass.                                                                                           |
| DDL-001–006                | exact-boundary domain tests and repository deadline-intent test                                                                                   | Deadlines are materialized per cycle/acknowledgement, do not slide, insert idempotently, and cancel on completion. Dispatch is intentionally Phase 4.                                                            |
| DB-001–004                 | v1 migration, five-point fault injection, concurrent duplicate, thread transaction, controller durable callback, Chromium/Firefox IndexedDB tests | Versioned validated records, atomic commit/rollback, unique event intake, and projection-after-commit pass.                                                                                                      |
| DB-005–008                 | storage-health tests, corruption quarantine, persistence controls, settings export/import, state restoration                                      | Failure is visible, persistence is user-requested, completed items are retained, and settings remain account scoped. Explicit cleanup and long-term diagnostic retention remain before-V1 work under DB-007/008. |
| UI-001–009, UI-011, UI-013 | `App.test.tsx`, 14-state visual catalog, local Matrix workflow screenshots                                                                        | Health/fault status, three work regions, domain actions, Matrix URI behavior, safe text, accessibility scan, focus/keyboard behavior, narrow layout, and non-color state pass.                                   |
| UI-010, UI-012             | Phase 4 E2EE/detail milestone                                                                                                                     | Full on-demand SDK/crypto detail is intentionally not claimed at Gate 3; durable preview/detail-unavailable behavior is the Phase 3 base.                                                                        |

The machine-readable Gate 3 report repeats the exact IDs and evidence groups in
`artifacts/reports/gate3-summary.json` after `npm run check:gate3`.
