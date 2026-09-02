# ADR-0009: Rust crypto device state and durable alert delivery

Status: Accepted

## Context

Encrypted Matrix activity can arrive before its room key, while browser audio, notification, and
webhook APIs can fail after workflow acceptance. Neither uncertainty may be hidden by delaying or
rolling back durable queue intake.

## Decision

- Initialize the Matrix SDK Rust/WASM crypto implementation before synchronization, using stable
  account-and-device-scoped IndexedDB names. One AckWatch tab owns those stores at a time.
- Commit an encrypted placeholder immediately and apply late decryption as idempotent maintenance.
  Store bounded previews and safe media metadata only; resolve complete bodies from the live SDK
  and crypto stores on demand.
- Keep passwords, recovery keys, secret-storage keys, access tokens, and webhook bearer tokens in
  session memory/storage only. Logout clears Matrix sync/crypto stores and in-memory secret keys.
- Use the public SDK flows for cross-signing, secret storage, key backup, and own-device SAS
  verification. SAS comparison data and generated recovery keys are ephemeral UI state.
- Materialize alert effects and per-transport deliveries transactionally after workflow acceptance.
  Claim delivery with a crash lease, retain an attempt ledger, retry bounded transient failures
  with backoff, and require an explicit manual retry after exhaustion.
- Send external transports a generic, content-free payload. Generic webhooks carry the effect ID in
  the body and `Idempotency-Key`; the ntfy JSON preset maps it to `sequence_id` and posts to the
  configured server root with the topic in the body.

## Consequences

AckWatch can guarantee durable intent and stable receiver identifiers, but not exactly-once OS or
network delivery. Audio, browser notifications, and webhooks operate only while the page is able to
run. Receivers should deduplicate by effect ID. A deployment must explicitly allow configured
Matrix and webhook origins in `connect-src`; AckWatch never broadens other CSP directives.
