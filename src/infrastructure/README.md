# Infrastructure adapters

Phase 2 and later place Matrix SDK, IndexedDB, browser lifecycle/ownership, notification, audio,
and webhook implementations here. Adapters implement contracts from `src/application/ports.ts` and
must not leak SDK or browser types into the domain.

No Matrix client or durable store is initialized during the Phase 1 foundation.
