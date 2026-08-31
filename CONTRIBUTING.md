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
