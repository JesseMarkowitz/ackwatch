import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const fileOutput = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
});
const files = fileOutput.split('\n').filter(Boolean);
const forbiddenPaths = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)artifacts\//,
  /(^|\/)dist(-catalog)?\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.research-sources\//,
];
const allowedEnvironmentTemplate = '.env.test.example';
const forbiddenFile = files.find(
  (file) =>
    file !== allowedEnvironmentTemplate && forbiddenPaths.some((pattern) => pattern.test(file)),
);

if (forbiddenFile) {
  throw new Error(`Forbidden generated or sensitive path is visible to Git: ${forbiddenFile}`);
}

for (const file of files) {
  if (file === allowedEnvironmentTemplate || file.startsWith('.git/')) continue;
  const contents = readFileSync(file);
  if (contents.includes(Buffer.from('\0'))) continue;

  const text = contents.toString('utf8');
  if (/ACKWATCH_MATRIX_\w+(PASSWORD|TOKEN)=\S+/.test(text)) {
    throw new Error(`A Matrix credential value appears in ${file}`);
  }
}

process.stdout.write(`Tracked-file audit passed for ${files.length} visible files.\n`);
