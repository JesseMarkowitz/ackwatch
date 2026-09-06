import { readFileSync } from 'node:fs';

import { worktreeIdentifier } from './worktree-identifier.mjs';

/**
 * The version the About panel shows, read from package.json at build time.
 *
 * Shared by the app build and the test config: a version defined in one and not the other means
 * either the panel is wrong or the component throws under test, and both have happened here.
 */
export function appVersionDefine(packageJsonUrl) {
  const { version } = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
  // The tree the bundle was built from, beside the version. A version answers "which release is
  // this"; a deployment being debugged needs "which build is this", and the two differ every time
  // something is deployed between releases. A `-modified` suffix says the build came from a tree
  // no commit holds, which is worth seeing in About rather than discovering later.
  return {
    __ACKWATCH_VERSION__: JSON.stringify(version),
    __ACKWATCH_BUILD__: JSON.stringify(worktreeIdentifier()),
  };
}
