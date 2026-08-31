# Dependency and license policy

Runtime dependencies are intentionally narrow:

- React and React DOM provide the user interface.
- Dexie is the approved IndexedDB wrapper for later workflow persistence.
- Fontsource packages provide locally bundled Manrope and JetBrains Mono variable fonts.

Development dependencies provide Vite/TypeScript compilation, lint/format controls, Vitest and
Testing Library, axe accessibility checks, Playwright browser automation, and Secretlint scanning.
Exact versions are recorded in `package.json` and `package-lock.json`.

`npm run report:licenses` inventories every installed package and fails if an AGPL dependency is
present. Its machine-readable output is written to `artifacts/reports/dependency-licenses.json`.
Unknown or non-standard license metadata must be reviewed before a release.

Reference clients under AGPL or other incompatible terms are study-only. No source may be copied
from them into AckWatch unless the project's licensing decision is explicitly amended.
