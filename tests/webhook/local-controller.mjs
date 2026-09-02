import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '../..');
const composeFile = resolve(root, 'tests/webhook/docker-compose.yml');
const artifactsDirectory = resolve(root, 'artifacts/webhook');
const ntfyUrl = 'http://127.0.0.1:18080';
const manifest = {
  service: 'ntfy',
  version: '2.28.0',
  imageDigest: 'sha256:6ef4b819f722fccdc036af611c4774cfdc2de821ab74fdd48bbf4c9d6f8973da',
  assertions: [],
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? 'unknown'}.`);
  }
  return result.stdout ?? '';
}

function compose(args, options) {
  return run('docker', ['compose', '-f', composeFile, ...args], options);
}

async function waitForService() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(`${ntfyUrl}/v1/health`);
      if (response.ok) return;
    } catch {
      // The isolated service is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Timed out waiting for the self-hosted ntfy service.');
}

mkdirSync(artifactsDirectory, { recursive: true });
try {
  compose(['up', '-d']);
  await waitForService();
  manifest.assertions.push('self-hosted-ntfy-ready');
  run(
    'npm',
    [
      'exec',
      '--',
      'vitest',
      'run',
      'src/infrastructure/browser/ntfy.integration.test.ts',
      '--reporter=default',
    ],
    { env: { ACKWATCH_NTFY_URL: ntfyUrl } },
  );
  manifest.assertions.push('ntfy-preset-private-publish');
  manifest.result = 'pass';
} catch (error) {
  manifest.result = 'fail';
  manifest.failure = error instanceof Error ? error.message : 'Unknown ntfy integration failure.';
  throw error;
} finally {
  try {
    compose(['down', '--volumes', '--remove-orphans']);
  } catch {
    // Preserve the original failure in the manifest.
  }
  writeFileSync(
    resolve(artifactsDirectory, 'local-webhook-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

process.stdout.write(
  `Local webhook scenario passed with ${manifest.assertions.length} assertions; manifest: artifacts/webhook/local-webhook-manifest.json\n`,
);
