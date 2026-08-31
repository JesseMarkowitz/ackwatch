# ADR-0006: Acknowledged deadline does not slide

- Status: Accepted
- Date: 2026-08-31

## Decision

The acknowledged-work deadline starts at the most recent explicit transition to `ACKNOWLEDGED`.
Later activity and `Review new activity` do not postpone it. A new explicit acknowledgement may
start a new deadline as defined by the domain command table.

## Consequences

New activity cannot indefinitely defer pending-work escalation. Deadlines are materialized in the
current attention cycle and use an injected clock for deterministic boundary tests.
