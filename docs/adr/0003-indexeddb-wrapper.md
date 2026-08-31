# ADR-0003: Dexie for workflow IndexedDB access

- Status: Accepted
- Date: 2026-08-31

## Context

The workflow repository needs versioned schemas, compound/unique indexes, transactions spanning
multiple stores, blocked-upgrade behavior, and testable failures. Matrix SDK sync and crypto stores
remain separate and are owned by the SDK.

## Decision

Use Dexie behind AckWatch's `WorkflowRepository` adapter. Domain and application code depend on
repository contracts, never Dexie APIs.

## Consequences

Dexie reduces raw IndexedDB ceremony but does not define transaction boundaries or runtime record
validation. Those remain explicit AckWatch responsibilities and will be fault-tested before the
persistence gate.
