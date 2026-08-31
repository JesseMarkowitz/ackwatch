# ADR-0007: Matrix SDK and truthful coverage boundary

Status: Accepted  
Date: 2026-08-31

## Context

AckWatch must distinguish cached state from a network-confirmed baseline, prevent concurrent tabs
from sharing one Matrix synchronization database, and recover limited timelines without silently
losing eligible events.

## Decision

- Pin `matrix-js-sdk` 42.2.0 as the Matrix client adapter.
- Acquire an exclusive per-account Web Lock before opening the SDK IndexedDB store.
- Treat cached `PREPARED` as cache restoration only. `ready` requires a non-cache sync, an empty
  serial ingestion queue, and no unresolved gap.
- Keep credentials in `sessionStorage`; keep passwords out of storage and logs.
- Buffer affected-room live events during limited-timeline recovery, paginate backward to the
  known boundary, then emit recovered events chronologically before the buffer.
- Persist failed gap markers in a separate Dexie database and make retry an explicit operation.
- Pin the disposable integration service to Synapse 1.157.2 by image digest. It is test
  infrastructure, not linked, packaged, or distributed with AckWatch.
- Defer Matrix crypto initialization and decryption to Phase 4. Encrypted wire events remain
  visible as ingestion issues in this phase.

## Consequences

Coverage health has more states than connectivity alone, and Start is intentionally unavailable
until a fresh baseline is proven. A second tab is blocked before SDK stores open. The SDK adds a
large browser payload; production chunk optimization is tracked as later performance work and does
not weaken this correctness boundary.
