# Phase 2 requirement traceability

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
