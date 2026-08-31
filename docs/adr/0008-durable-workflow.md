# ADR-0008: Durable workflow transactions and Matrix URIs

Status: Accepted

## Context

Phase 3 turns accepted Matrix activity into user-managed work. A successful intake must not leave
an activity without its queue item, transition, conversation identity, deadline, or alert intent.
The browser UI also needs a protocol-native escape hatch without introducing an external resolver.

## Decision

- The pure queue domain owns state transitions, cycle-scoped deadlines, sorting, thread promotion,
  and deterministic alert-effect identities. It has no React, Matrix SDK, IndexedDB, browser, or
  wall-clock dependency.
- Dexie schema version 2 adds account-scoped workflow, settings, monitoring-session, ingestion,
  effect, and quarantine stores while retaining the released Phase 2 coverage-issue store.
- Activity acceptance and thread promotion/merge are single IndexedDB transactions. UI projection
  runs only after commit. Runtime validation is performed with Zod, and malformed queue records are
  removed to a redacted quarantine record instead of being rendered.
- Alert delivery remains Phase 4 work. Phase 3 durably records idempotent, cycle-scoped effect
  intents and cancels obsolete pending intents in the same command transaction.
- Open and copy actions use percent-encoded `matrix:` event URIs. AckWatch does not create a
  `matrix.to` or other web-resolver URL.

## Consequences

Reload restores workflow and account settings but intentionally leaves monitoring off. Storage
failure is a visible fatal condition; there is no volatile fallback. Full decrypted event detail
and effect dispatch remain explicit Phase 4 boundaries.
