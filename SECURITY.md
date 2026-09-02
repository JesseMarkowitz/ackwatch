# Security and privacy

AckWatch is designed for local operation, but browser storage and an active browser session are
not confidentiality boundaries. Anyone who can execute script in the application origin or read
the browser profile may be able to access active credentials or stored workflow previews.

## Reporting a vulnerability

Do not open a public issue containing credentials, private Matrix content, or an exploit that
could expose either. Until a private project contact is published, contact the repository owner
through an already established private channel and include only the minimum reproduction data.

## Project rules

- Passwords, tokens, recovery material, decrypted bodies, and raw authentication responses are
  excluded from logs and diagnostics.
- V1 credentials are session-only; remembered login is not offered.
- Production runtime assets are bundled locally. There is no analytics or telemetry.
- Matrix content is rendered as text and never as injected formatted HTML.
- Production source maps are disabled unless later handled as private artifacts.
- Dependency versions are locked and audited. AGPL reference code is study-only and cannot be
  copied into this Apache-2.0 project.
- HTTPS is required outside explicit loopback development.
- Rust crypto state is account/device scoped in IndexedDB. Generated recovery keys and SAS values
  are temporary UI state; secret-storage keys are zeroed from AckWatch memory on stop/logout.
- Workflow storage contains only bounded previews and safe attachment metadata. Full decrypted
  bodies are resolved on demand from the active Matrix SDK and are not placed in the alert outbox.
- Webhook bearer tokens live in session storage, are excluded from settings export, diagnostics,
  URLs, and payloads, and are cleared on logout. External payloads omit rooms, senders, previews,
  attachment names, event URIs, raw events, and Matrix credentials.
- Browser alert delivery is best effort while the page runs. Receivers must treat the deterministic
  effect ID/ntfy sequence ID as a deduplication key rather than assuming exactly-once delivery.

The final production CSP remains a Phase 5 deployment task. It must allow only the deployed Matrix
origin and operator-approved webhook origins in `connect-src`, retain local-only script/font/media
directives, and permit the bundled Rust crypto WASM without enabling remote code. A browser CORS
failure is reported as transport failure; it is never worked around by weakening unrelated policy.
