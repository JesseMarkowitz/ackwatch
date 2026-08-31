# Dependency and license policy

Runtime dependencies are intentionally narrow:

- React and React DOM provide the user interface.
- Dexie is the approved IndexedDB wrapper for later workflow persistence.
- `matrix-js-sdk` is the pinned Matrix client, synchronization, and IndexedDB-store adapter.
- Zod validates session credentials and persisted coverage diagnostics at storage boundaries.
- Fontsource packages provide locally bundled Manrope and JetBrains Mono variable fonts.

Development dependencies provide Vite/TypeScript compilation, lint/format controls, Vitest and
Testing Library, axe accessibility checks, Playwright browser automation, and Secretlint scanning.
`fake-indexeddb` exercises durable browser records without a browser process.
Exact versions are recorded in `package.json` and `package-lock.json`.

`npm run report:licenses` inventories every installed package and fails if an AGPL dependency is
present. Its machine-readable output is written to `artifacts/reports/dependency-licenses.json`.
Unknown or non-standard license metadata must be reviewed before a release.

Reference clients under AGPL or other incompatible terms are study-only. No source may be copied
from them into AckWatch unless the project's licensing decision is explicitly amended.

The pinned Synapse image is an isolated, disposable integration-test service. It is not an npm
dependency, linked library, production service, copied source, or distributed AckWatch artifact.
Its image tag and digest are recorded in `tests/matrix/docker-compose.yml` and ADR-0007.
