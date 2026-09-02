# Architecture

The repository starts with boundaries that keep Matrix and browser mechanics from becoming queue
rules.

```text
src/
├── domain/                 pure workflow rules and injected clock
├── application/            use cases and ports
├── infrastructure/         Matrix, IndexedDB, browser, and transport adapters
├── app/                    React composition and presentation
└── testing/                test-only fixtures and state catalog
tests/
├── browser/                production-build system checks
├── matrix/                 disposable real-Matrix controller
└── visual/                 deterministic catalog captures
tools/                      repository audits, reports, gallery, static server
```

Dependencies point inward: infrastructure and UI may depend on application/domain contracts, but
the domain never imports React, Matrix, IndexedDB, browser globals, or wall-clock APIs. React
dispatches application commands instead of reproducing transitions.

The state catalog is selected only in Vite's `catalog` mode. The ordinary production build removes
that branch, and `tools/assert-production-bundle.mjs` fails if catalog markers or source maps appear
in `dist/`.

Phase 2 keeps SDK callbacks behind a non-throwing serial ingestion boundary. An exclusive account
lock is acquired before any SDK database opens. The coverage machine combines network baseline,
ingestion drain, and gap state; connectivity alone can never claim healthy monitoring. Failed gap
records live in a small adapter-owned database and do not become workflow queue items.

Phase 3 adds a pure queue aggregate and a shared versioned workflow database. Qualifying normalized
activity is accepted in one transaction across activity, item, conversation key, transition,
effect intent, and settings stores. The controller refreshes the UI projection only after that
transaction commits. Stable account/event identities make replay idempotent; stable conversation
keys allow a root and racing thread reply to be promoted and merged atomically.

Workflow records contain bounded text previews and metadata, not complete decrypted message
bodies. Zod validates records at the repository boundary. Invalid queue records become redacted
quarantine entries and storage health remains visibly degraded until the user resolves the data
problem. Monitoring session records are durable for diagnostics, but monitoring intent itself is
deliberately never restored.

Phase 4 initializes the Matrix SDK Rust/WASM crypto engine before sync. SDK sync and crypto stores
have stable account-and-device namespaces and are protected by the same exclusive account lock.
Encrypted wire events enter the workflow immediately as bounded placeholders; SDK decryption
callbacks apply idempotent success/failure maintenance. Complete bodies and relation/media detail
are resolved from the live SDK timeline on demand and never copied into workflow storage.

Alert effects form a transactional outbox. A single absolute-deadline scheduler evaluates on its
interval and on startup/focus/visibility/pageshow. The dispatcher creates one durable delivery per
enabled transport, claims it with a crash lease, records every attempt, and settles it as delivered,
pending with capped backoff, or exhausted. Audio and notifications are browser adapters; webhook
credentials have a separate session-only boundary. Transport state cannot mutate queue state or
overstate Matrix coverage.
