# ADR-0002: Node 22.23.1 and npm 10.9.8

- Status: Accepted
- Date: 2026-08-31

## Decision

Development and automation use Node `22.23.1` and npm `10.9.8`. Versions are pinned in `.nvmrc`,
`package.json`, and the npm lockfile. The repository's default branch is the existing `main` branch;
automation does not change it or create a remote.

## Consequences

`npm ci` is the reproducible install path. Upgrading either tool is an explicit reviewed change and
must rerun all release-eligible checks.
