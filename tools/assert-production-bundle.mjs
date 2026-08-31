import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const forbiddenMarkers = ['data-catalog-state', 'CatalogState', 'signed-out-narrow'];
const files = readdirSync('dist', { recursive: true, withFileTypes: true });

for (const file of files) {
  if (!file.isFile()) continue;
  const filePath = join(file.parentPath, file.name);

  if (extname(file.name) === '.map') {
    throw new Error(`Production source map is forbidden: ${filePath}`);
  }

  if (['.html', '.js', '.css'].includes(extname(file.name))) {
    const contents = readFileSync(filePath, 'utf8');
    const marker = forbiddenMarkers.find((candidate) => contents.includes(candidate));
    if (marker) throw new Error(`Test catalog marker ${marker} leaked into ${filePath}`);
  }
}

process.stdout.write('Production bundle excludes the test-state catalog and source maps.\n');
