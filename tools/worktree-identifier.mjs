import { execFileSync } from 'node:child_process';

// Identifies the tree a piece of evidence was produced from. A bare commit sha is not enough: a
// dirty worktree can render screenshots or a build that no commit contains, and evidence labelled
// with a commit it does not match is worse than evidence labelled with nothing. A `-modified`
// suffix says plainly that what was measured is not what any commit holds.
export function worktreeIdentifier() {
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const head = git(['rev-parse', '--short', 'HEAD']);
    return git(['status', '--porcelain']) === '' ? head : `${head}-modified`;
  } catch {
    // The approved foundation starts before the human creates the first commit.
    return 'uncommitted-worktree';
  }
}
