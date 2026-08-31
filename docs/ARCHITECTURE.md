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
