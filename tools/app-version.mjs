import { readFileSync } from 'node:fs';

/**
 * The version the About panel shows, read from package.json at build time.
 *
 * Shared by the app build and the test config: a version defined in one and not the other means
 * either the panel is wrong or the component throws under test, and both have happened here.
 */
export function appVersionDefine(packageJsonUrl) {
  const { version } = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
  return { __ACKWATCH_VERSION__: JSON.stringify(version) };
}
