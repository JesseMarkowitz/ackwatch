# ADR-0004: Session-only Matrix credentials

- Status: Accepted
- Date: 2026-08-31

## Decision

V1 never offers remembered login. Passwords are not persisted or logged; active/refresh tokens live
only within the browser session credential boundary. Logout invalidates the remote token where
possible and clears credential, SDK sync, and crypto stores according to the specification.

## Consequences

Reload and restart are always unarmed and may require reauthentication. Durable workflow/settings
data is independent of credentials. A later Tauri wrapper may replace the credential adapter
without changing domain rules.
