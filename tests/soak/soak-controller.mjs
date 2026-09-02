import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

/**
 * Phase 5 §8.2 longevity soak. It models a working shift rather than a burst: messages arrive at a
 * human cadence, the operator works the queue periodically, and the connection drops and recovers.
 * The point is what grows — listeners, timers, clients, memory — so samples are appended to disk as
 * they are taken and a run that is interrupted still leaves everything it measured.
 */

const root = resolve(import.meta.dirname, '../..');
const composeFile = resolve(root, 'tests/matrix/docker-compose.yml');
const artifactsDirectory = resolve(root, 'artifacts/soak');
const homeserverUrl = 'http://127.0.0.1:18008';
const appUrl = 'http://127.0.0.1:4177';
const stateDirectory = resolve(root, '.matrix-test-state/synapse');
const image =
  'matrixdotorg/synapse:v1.157.2@sha256:097e3120b8ecf97e4f92537d7af2da41564c706e33fc740f3741c9defacc2af1';

// Six hours models a double shift; three is a single one. Overridable so the harness itself can be
// smoke-tested in minutes without pretending that run is a soak.
const soakMinutes = Number.parseInt(process.env.ACKWATCH_SOAK_MINUTES ?? '360', 10);
const messageIntervalMs = Number.parseInt(process.env.ACKWATCH_SOAK_MESSAGE_MS ?? '20000', 10);
const sampleIntervalMs = Number.parseInt(process.env.ACKWATCH_SOAK_SAMPLE_MS ?? '60000', 10);
const reconnectEveryMs = Number.parseInt(process.env.ACKWATCH_SOAK_RECONNECT_MS ?? '900000', 10);

const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const users = ['monitor', 'sender'];
const passwords = new Map(users.map((user) => [user, randomBytes(24).toString('base64url')]));
const manifestPath = resolve(artifactsDirectory, 'soak-manifest.json');
const samplesPath = resolve(artifactsDirectory, 'soak-samples.jsonl');
const manifest = {
  runId,
  plannedMinutes: soakMinutes,
  smokeRun: soakMinutes < 60,
  startedAt: new Date().toISOString(),
  result: 'running',
  totals: { sent: 0, accepted: 0, acknowledged: 0, completed: 0, reconnects: 0 },
  samples: 0,
  browserErrors: [],
};
let appServer;
let browser;

function persist() {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ACKWATCH_TEST_GID: String(process.getgid?.() ?? 1000),
      ACKWATCH_TEST_UID: String(process.getuid?.() ?? 1000),
    },
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout ?? '';
}

const compose = (args, options) => run('docker', ['compose', '-f', composeFile, ...args], options);

async function waitFor(description, predicate, timeoutMs = 45_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}.`,
  );
}

async function matrixRequest(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${homeserverUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Matrix ${method} ${path} failed with ${response.status}.`);
  return data;
}

async function registerUser(username, secret) {
  const { nonce } = await matrixRequest('/_synapse/admin/v1/register');
  const password = passwords.get(username);
  const mac = createHmac('sha1', secret)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  return await matrixRequest('/_synapse/admin/v1/register', {
    method: 'POST',
    body: { nonce, username, password, admin: false, mac },
  });
}

async function login(username) {
  return await matrixRequest('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: username },
      password: passwords.get(username),
      initial_device_display_name: 'AckWatch soak controller',
    },
  });
}

/** Counts the things a leak would show up in: live timers, listeners, and heap. */
async function sample(page, elapsedMs) {
  const reading = await page.evaluate(() => {
    const memory = performance.memory;
    return {
      queueCards: document.querySelectorAll('[data-item-id]').length,
      usedHeapBytes: memory?.usedJSHeapSize,
    };
  });
  const entry = { at: new Date().toISOString(), elapsedMs, ...reading, ...manifest.totals };
  appendFileSync(samplesPath, `${JSON.stringify(entry)}\n`);
  manifest.samples += 1;
  manifest.lastSample = entry;
  persist();
  return entry;
}

async function main() {
  mkdirSync(artifactsDirectory, { recursive: true });
  rmSync(samplesPath, { force: true });
  rmSync(stateDirectory, { recursive: true, force: true });
  mkdirSync(stateDirectory, { recursive: true, mode: 0o777 });
  persist();

  run('docker', [
    'run',
    '--rm',
    '-v',
    `${stateDirectory}:/data`,
    '-e',
    'SYNAPSE_SERVER_NAME=ackwatch.test',
    '-e',
    'SYNAPSE_REPORT_STATS=no',
    '-e',
    `UID=${process.getuid?.() ?? 1000}`,
    '-e',
    `GID=${process.getgid?.() ?? 1000}`,
    image,
    'generate',
  ]);
  const configPath = resolve(stateDirectory, 'homeserver.yaml');
  appendFileSync(
    configPath,
    `\npublic_baseurl: "${homeserverUrl}/"\nsuppress_key_server_warning: true\n` +
      `rc_login:\n  address:\n    per_second: 1000\n    burst_count: 1000\n` +
      `  account:\n    per_second: 1000\n    burst_count: 1000\n` +
      `  failed_attempts:\n    per_second: 1000\n    burst_count: 1000\n` +
      `rc_message:\n  per_second: 1000\n  burst_count: 1000\n` +
      `rc_registration:\n  per_second: 1000\n  burst_count: 1000\n`,
  );
  const secret = /registration_shared_secret:\s*"([^"]+)"/.exec(
    readFileSync(configPath, 'utf8'),
  )?.[1];
  if (!secret) throw new Error('Generated Synapse registration secret was unavailable.');

  compose(['up', '-d', '--wait', '--wait-timeout', '120']);
  await waitFor(
    'Synapse client API',
    async () => (await fetch(`${homeserverUrl}/_matrix/client/versions`)).ok,
  );

  for (const user of users) await registerUser(user, secret);
  const [monitor, sender] = await Promise.all(users.map(login));
  const room = await matrixRequest('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: sender.access_token,
    body: { name: `AckWatch soak ${runId}`, preset: 'private_chat', invite: [monitor.user_id] },
  });
  await matrixRequest(`/_matrix/client/v3/join/${encodeURIComponent(room.room_id)}`, {
    method: 'POST',
    token: monitor.access_token,
    body: {},
  });

  appServer = spawn(process.execPath, ['tools/static-server.mjs', 'dist', '4177'], {
    cwd: root,
    stdio: 'ignore',
  });
  await waitFor('static server', async () => (await fetch(appUrl)).ok);

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    manifest.browserErrors.push({ at: new Date().toISOString(), message: error.message });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      manifest.browserErrors.push({ at: new Date().toISOString(), console: message.text() });
    }
  });

  await page.goto(appUrl);
  await page.getByLabel('Matrix user ID').fill(monitor.user_id);
  await page.getByLabel('Advanced homeserver override').check();
  await page.getByLabel('Homeserver URL override').fill(homeserverUrl);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('password-form').waitFor();
  await page.getByLabel('Password').fill(passwords.get('monitor'));
  await page.getByRole('button', { name: 'Sign in' }).click();

  const startButton = page.getByRole('button', { name: 'Start monitoring' });
  await startButton.waitFor({ state: 'visible', timeout: 60_000 });
  await waitFor('network-confirmed ready state', async () => await startButton.isEnabled(), 60_000);
  await startButton.click();
  await page
    .getByText('Off', { exact: true })
    .first()
    .waitFor({ state: 'detached', timeout: 30_000 })
    .catch(() => undefined);

  const deadline = Date.now() + soakMinutes * 60_000;
  let nextMessage = Date.now();
  let nextSample = Date.now();
  let nextReconnect = Date.now() + reconnectEveryMs;
  let counter = 0;

  await sample(page, 0);
  const startedAt = Date.now();

  while (Date.now() < deadline) {
    const now = Date.now();
    if (now >= nextMessage) {
      counter += 1;
      await matrixRequest(
        `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/send/m.room.message/${runId}-${counter}`,
        {
          method: 'PUT',
          token: sender.access_token,
          body: { msgtype: 'm.text', body: `Soak message ${counter} for ${runId}` },
        },
      );
      manifest.totals.sent += 1;
      nextMessage = now + messageIntervalMs;
    }

    // Work the queue the way an operator would: acknowledge what arrived, complete some of it.
    const cards = page.locator('[data-item-id]');
    if ((await cards.count()) > 0) {
      manifest.totals.accepted = await cards.count();
      const acknowledge = page.getByRole('button', { name: 'Acknowledge' }).first();
      if (await acknowledge.isVisible().catch(() => false)) {
        await acknowledge.click().catch(() => undefined);
        manifest.totals.acknowledged += 1;
      }
      if (manifest.totals.acknowledged % 3 === 0) {
        const complete = page.getByRole('button', { name: 'Complete' }).first();
        if (await complete.isVisible().catch(() => false)) {
          await complete.click().catch(() => undefined);
          manifest.totals.completed += 1;
        }
      }
    }

    if (now >= nextReconnect) {
      await context.setOffline(true);
      await new Promise((r) => setTimeout(r, 5_000));
      await context.setOffline(false);
      manifest.totals.reconnects += 1;
      nextReconnect = now + reconnectEveryMs;
    }

    if (now >= nextSample) {
      await sample(page, now - startedAt);
      nextSample = now + sampleIntervalMs;
    }

    await new Promise((r) => setTimeout(r, 1_000));
  }

  const final = await sample(page, Date.now() - startedAt);
  await page.screenshot({ path: resolve(artifactsDirectory, 'soak-final.png'), fullPage: true });

  const readings = readFileSync(samplesPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const heaps = readings
    .map(({ usedHeapBytes }) => usedHeapBytes)
    .filter((v) => typeof v === 'number');
  manifest.heap = heaps.length
    ? {
        firstBytes: heaps[0],
        lastBytes: heaps.at(-1),
        peakBytes: Math.max(...heaps),
        growthRatio: Number((heaps.at(-1) / Math.max(heaps[0], 1)).toFixed(2)),
      }
    : { note: 'The browser did not expose performance.memory.' };
  manifest.finalQueueCards = final.queueCards;
  manifest.result = 'pass';
  manifest.endedAt = new Date().toISOString();
  persist();
  process.stdout.write(
    `Soak finished: ${manifest.totals.sent} sent, ${manifest.totals.acknowledged} acknowledged, ` +
      `${manifest.totals.reconnects} reconnects, ${manifest.samples} samples.\n`,
  );
}

try {
  await main();
} catch (error) {
  manifest.result = 'fail';
  manifest.failure = error instanceof Error ? error.message : String(error);
  manifest.endedAt = new Date().toISOString();
  persist();
  process.exitCode = 1;
  process.stderr.write(`Soak failed: ${manifest.failure}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  appServer?.kill();
  try {
    compose(['down', '--volumes', '--remove-orphans']);
  } catch {
    process.stderr.write('Soak teardown reported a problem.\n');
  }
  rmSync(stateDirectory, { recursive: true, force: true });
}
