# AckWatch

AckWatch is a local-first attention monitor for Matrix. It is an independent open-source
project and is not endorsed by The Matrix.org Foundation or Element.

The application is currently at the Phase 1 foundation gate. The shell, architectural
boundaries, deterministic test harness, and project controls exist; Matrix login and monitoring
behavior begin only after Gate 1 approval.

## Requirements

- Node.js `22.23.1`
- npm `10.9.8`
- Current desktop Chromium and Firefox for browser qualification
- Docker with Compose for the later disposable Matrix/webhook integration stack

Use `nvm use` when nvm is available. npm enforces the approved runtime line through `engines`
and records its own version through `packageManager`.

## Start locally

```bash
npm ci
npm run setup:browsers
npm run dev
```

No credential is required for the foundation. A future optional remote homeserver compatibility
run uses the names documented in [`.env.test.example`](./.env.test.example), with values placed
only in the ignored `.env.test.local` file.

## Verification

```bash
npm run check:fast
npm run build
npm run test:browser
npm run test:visual
npm run audit:secrets
npm run audit:tracked
npm run audit:dependencies
npm run report:licenses
```

`npm run check:gate1` runs that full sequence. Generated reports, screenshots, traces, and the
HTML gallery are written beneath ignored `artifacts/`.

See [Testing](./docs/TESTING.md), [Architecture](./docs/ARCHITECTURE.md), and the
[ADR index](./docs/adr/README.md) for the decisions behind the foundation.

## Current boundaries

- Monitoring is never represented as continuing after the page closes.
- No analytics, remote fonts, third-party runtime code, or telemetry are included.
- Matrix credentials will be session-only and are not implemented yet.
- Codex does not commit, push, publish, or mutate repository hosting state.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
