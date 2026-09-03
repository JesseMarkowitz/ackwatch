# AckWatch

AckWatch is a local-first attention monitor for Matrix. It is an independent open-source
project and is not endorsed by The Matrix.org Foundation or Element.

The application is at the Phase 4 reliability-beta gate. It supports session-only password login,
exclusive account ownership, a network-confirmed monitoring boundary, serial event intake, and a
durable attention workflow with thread merge, deadlines, settings transfer, storage health, and
reload restoration. Phase 4 adds end-to-end encryption with a persistent device — cross-signing,
secret storage, key backup, and emoji device verification — the complete V1 event table, and
durable alert delivery through bundled audio, browser notifications, and an optional generic or
ntfy-compatible webhook. Monitoring still returns off after every reload.

AckWatch monitors for a working session rather than tracking indefinitely. A session holds the
queue you are working through and survives a reload or a crash: returning within the continuity
window (12 hours by default, configurable) offers the interrupted session back with your
acknowledgements intact, while an older one is archived to a redacted summary and replaced. Ending
a session archives it the same way and clears its work, leaving your configuration alone.

## Requirements

- Node.js `22.23.1`
- npm `10.9.8`
- Current desktop Chromium and Firefox for browser qualification
- Docker with Compose for the disposable Matrix integration stack

Use `nvm use` when nvm is available. npm enforces the approved runtime line through `engines`
and records its own version through `packageManager`.

## Start locally

```bash
npm ci
npm run setup:browsers
npm run dev
```

No credential is required for the core test path; it provisions a disposable local Matrix server.
Optional remote homeserver compatibility values use the names in
[`.env.test.example`](./.env.test.example), with values only in ignored `.env.test.local`.

## Verification

```bash
npm run check:fast
npm run build
npm run test:browser
npm run test:visual
npm run test:matrix:local
npm run test:webhook:local
npm run test:scale
npm run audit:secrets
npm run audit:tracked
npm run audit:dependencies
npm run report:licenses
```

`npm run check:gate4` runs the complete Phase 4 sequence and `npm run check:gate5` the V1 release
matrix. Both need Docker for the disposable Synapse and ntfy stacks, and both record each step as it
passes so the generated report reflects what actually ran. Generated reports, screenshots, traces,
and the HTML gallery are written beneath ignored `artifacts/`.

`npm run test:soak` is the longevity run and is scheduled separately: it holds the machine and
Docker for six hours by default. Gate 5 reads its recorded manifest rather than re-running it.

See [Deployment](./docs/DEPLOYMENT.md) for the Content Security Policy and hosting notes, plus
[Testing](./docs/TESTING.md), [Architecture](./docs/ARCHITECTURE.md), and the
[ADR index](./docs/adr/README.md) for the decisions behind the implementation.

## Current boundaries

- Monitoring is never represented as continuing after the page closes.
- No analytics, remote fonts, third-party runtime code, or telemetry are included.
- Matrix credentials are session-only; passwords are never retained.
- Monitoring never auto-resumes after reload, and incomplete gap recovery cannot appear healthy.
- Codex does not commit, push, publish, or mutate repository hosting state.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
