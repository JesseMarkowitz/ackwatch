import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const dependencies = Object.entries(lockfile.packages)
  .filter(([path, metadata]) => path && metadata.version)
  .map(([path, metadata]) => ({
    license: metadata.license ?? 'UNKNOWN',
    name: path.replace(/^node_modules\//, ''),
    version: metadata.version,
  }))
  .sort((left, right) => left.name.localeCompare(right.name));
const disallowed = dependencies.filter(({ license }) => /(^|\()AGPL/i.test(String(license)));

mkdirSync('artifacts/reports', { recursive: true });
writeFileSync(
  'artifacts/reports/dependency-licenses.json',
  `${JSON.stringify({ dependencies, generatedAt: new Date().toISOString() }, null, 2)}\n`,
);

if (disallowed.length > 0) {
  throw new Error(
    `AGPL dependency detected: ${disallowed.map(({ name, version }) => `${name}@${version}`).join(', ')}`,
  );
}

const unknown = dependencies.filter(({ license }) => license === 'UNKNOWN');
process.stdout.write(
  `License inventory: ${dependencies.length} packages, ${unknown.length} unknown, 0 AGPL.\n`,
);
