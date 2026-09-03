import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { worktreeIdentifier as identifyWorktree } from './worktree-identifier.mjs';

const screenshotDirectory = join('artifacts', 'screenshots');
const reportDirectory = join('artifacts', 'gallery');
const images = readdirSync(screenshotDirectory)
  .filter((file) => file.endsWith('.png'))
  .sort();
const worktreeIdentifier = identifyWorktree();

mkdirSync(reportDirectory, { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  browser: 'Playwright Chromium',
  colorScheme: 'light',
  deviceScaleFactor: 1,
  locale: 'en-US',
  motion: 'reduced',
  source: 'synthetic typed state catalog',
  timezone: 'UTC',
  worktreeIdentifier,
  screenshots: images.map((file) => ({ file, scenario: basename(file, '.png') })),
};

writeFileSync(join(reportDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  join(reportDirectory, 'index.html'),
  `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>AckWatch screenshot gallery</title>
<style>body{font:16px system-ui;margin:2rem;background:#ebe8df;color:#172223}main{display:grid;gap:2rem}figure{margin:0;padding:1rem;background:#fff;border-radius:.5rem}img{display:block;max-width:100%;margin-top:1rem;border:1px solid #ccc}code{font-size:.8rem}</style>
<h1>AckWatch Gate 1 screenshot gallery</h1><p>Deterministic synthetic fixtures · Chromium · UTC · en-US · reduced motion</p>
<main>${images.map((file) => `<figure><figcaption><code>${basename(file, '.png')}</code></figcaption><img src="../screenshots/${file}" alt="${basename(file, '.png')} screenshot"></figure>`).join('')}</main></html>\n`,
);

process.stdout.write(`Generated gallery for ${images.length} screenshots at ${reportDirectory}.\n`);
