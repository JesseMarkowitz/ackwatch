# Contributing

AckWatch is specified before it is implemented. Behavioral work must cite the relevant IDs in
`docs/SPECIFICATION.md`; the research review is rationale, not a compatibility contract.

## Local workflow

1. Use Node `22.23.1` and npm `10.9.8`.
2. Run `npm ci` to reproduce the lockfile.
3. Keep domain code independent of React, Matrix, IndexedDB, browser globals, and wall-clock APIs.
4. Add tests at the same time as behavior.
5. Run `npm run check:fast` before requesting review.
6. Run the milestone-appropriate integration and browser suites before a gate.

Generated output belongs in `artifacts/` and must not be committed. Credentials belong only in
ignored local environment files or approved CI secret storage. Do not include real account names,
room names, event content, or tokens in screenshots and reports.

Visual baseline changes require human approval. A failing or flaky test is investigated rather
than permanently retried or silently skipped.

## Toolchain

- Node.js `22.23.1`, npm `10.9.8` — `nvm use` when nvm is available. npm enforces the runtime line
  through `engines` and records its own version through `packageManager`.
- Current desktop Chromium and Firefox for browser qualification (`npm run setup:browsers`).
- Docker with Compose for the disposable Matrix and ntfy stacks.

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
matrix. Both need Docker, and both record each step as it passes so the generated report reflects
what actually ran. Generated reports, screenshots, traces, and the HTML gallery are written beneath
ignored `artifacts/`.

`npm run test:soak` is the longevity run and is scheduled separately: it holds the machine and
Docker for six hours by default. Gate 5 reads its recorded manifest rather than re-running it.

## Repository conventions

- The assistant does not commit, push, publish, or mutate repository hosting state. It proposes the
  command; a human runs it.
- `tools/rasterize-icons.py` and `tools/generate-alert-tone.py` are the sources of the application
  mark and the alert sound. Regenerate rather than hand-editing their output.
- `instructions.md` is rendered into the build by `tools/build-instructions.mjs` and linked from
  the application, so it is user-facing documentation rather than a developer note.
