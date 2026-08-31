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

The tested deployment CSP will be derived from the actual Matrix crypto, worker, media, and
webhook behavior during release hardening rather than copied speculatively into this foundation.
