import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const stateDirectory = resolve(root, '.matrix-test-state/synapse');
const composeFile = resolve(root, 'tests/matrix/docker-compose.yml');
const artifactsDirectory = resolve(root, 'artifacts/matrix');
const homeserverUrl = 'http://127.0.0.1:18008';
const appUrl = 'http://127.0.0.1:4175';
const image =
  'matrixdotorg/synapse:v1.157.2@sha256:097e3120b8ecf97e4f92537d7af2da41564c706e33fc740f3741c9defacc2af1';
const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const roomName = `AckWatch synthetic ${runId}`;
const users = ['monitor', 'sendera', 'senderb'];
const passwords = new Map(users.map((user) => [user, randomBytes(24).toString('base64url')]));
const manifest = {
  runId,
  homeserver: { implementation: 'Synapse', version: '1.157.2', url: homeserverUrl },
  roomId: undefined,
  eventIds: {},
  assertions: [],
  cleanup: [],
};
let appServer;
let browser;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ACKWATCH_TEST_GID: String(process.getgid?.() ?? 1000),
      ACKWATCH_TEST_UID: String(process.getuid?.() ?? 1000),
    },
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

async function waitFor(description, predicate, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
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
  if (!response.ok) {
    throw new Error(
      `Matrix ${method} ${path} failed with ${response.status}${typeof data.errcode === 'string' ? ` (${data.errcode})` : ''}.`,
    );
  }
  return data;
}

async function registerUser(username, password, secret) {
  const { nonce } = await matrixRequest('/_synapse/admin/v1/register');
  const mac = createHmac('sha1', secret)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  await matrixRequest('/_synapse/admin/v1/register', {
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
      initial_device_display_name: 'AckWatch fixture controller',
    },
  });
}

async function sendMessage(roomId, token, marker) {
  const transactionId = `${runId}-${marker}`;
  return await matrixRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
    {
      method: 'PUT',
      token,
      body: { msgtype: 'm.text', body: `Synthetic ${marker} ${runId}` },
    },
  );
}

async function loginInBrowser(page, userId, password) {
  await page.goto(appUrl);
  await page.getByLabel('Matrix user ID').fill(userId);
  await page.getByLabel('Advanced homeserver override').check();
  await page.getByLabel('Homeserver URL override').fill(homeserverUrl);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('password-form').waitFor();
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function waitForProcessed(page, eventId) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector('.queue-preview')?.getAttribute('data-last-processed-event-id') ===
      expected,
    eventId,
    { timeout: 30_000 },
  );
}

async function cleanupRoom(roomId, sessions) {
  for (const session of sessions) {
    try {
      await matrixRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
        method: 'POST',
        token: session.access_token,
        body: {},
      });
      await matrixRequest(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/forget`, {
        method: 'POST',
        token: session.access_token,
        body: {},
      });
      manifest.cleanup.push({ userId: session.user_id, status: 'left-and-forgotten' });
    } catch (error) {
      manifest.cleanup.push({
        userId: session.user_id,
        status: 'failed',
        detail: error instanceof Error ? error.message : 'unknown cleanup failure',
      });
    }
  }
}

async function main() {
  mkdirSync(artifactsDirectory, { recursive: true });
  rmSync(stateDirectory, { recursive: true, force: true });
  mkdirSync(stateDirectory, { recursive: true, mode: 0o777 });

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
  appendFileSync(
    resolve(stateDirectory, 'homeserver.yaml'),
    `\npublic_baseurl: "${homeserverUrl}/"\nsuppress_key_server_warning: true\n`,
  );
  const configuration = readFileSync(resolve(stateDirectory, 'homeserver.yaml'), 'utf8');
  const registrationSecret = /registration_shared_secret:\s*"([^"]+)"/.exec(configuration)?.[1];
  if (!registrationSecret)
    throw new Error('Generated Synapse registration secret was unavailable.');

  compose(['up', '-d', '--wait', '--wait-timeout', '90']);
  await waitFor('Synapse client API', async () => {
    const response = await fetch(`${homeserverUrl}/_matrix/client/versions`);
    return response.ok;
  });

  for (const user of users) await registerUser(user, passwords.get(user), registrationSecret);
  const [monitor, senderA, senderB] = await Promise.all(users.map(login));
  const room = await matrixRequest('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: senderA.access_token,
    body: {
      name: roomName,
      preset: 'private_chat',
      invite: [monitor.user_id, senderB.user_id],
    },
  });
  manifest.roomId = room.room_id;
  for (const session of [monitor, senderB]) {
    await matrixRequest(`/_matrix/client/v3/join/${encodeURIComponent(room.room_id)}`, {
      method: 'POST',
      token: session.access_token,
      body: {},
    });
  }
  const baseline = await sendMessage(room.room_id, senderA.access_token, 'baseline');
  manifest.eventIds.baseline = baseline.event_id;

  appServer = spawn(process.execPath, ['tools/static-server.mjs', 'dist', '4175'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor('AckWatch production server', async () => {
    const response = await fetch(appUrl);
    return response.ok;
  });

  browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  await loginInBrowser(page, monitor.user_id, passwords.get('monitor'));
  const startButton = page.getByRole('button', { name: 'Start monitoring' });
  await startButton.waitFor({ state: 'visible', timeout: 45_000 });
  await waitFor('network-confirmed ready state', async () => await startButton.isEnabled(), 45_000);
  if ((await page.locator(`[data-event-id="${baseline.event_id}"]`).count()) !== 0) {
    throw new Error('The pre-arm baseline event entered the developer ledger.');
  }
  manifest.assertions.push('baseline-excluded');
  await page.screenshot({ path: resolve(artifactsDirectory, 'real-ready.png'), fullPage: true });

  await startButton.click();
  await page.getByText('Monitoring is armed').waitFor();
  const accepted = await sendMessage(room.room_id, senderA.access_token, 'post-arm');
  manifest.eventIds.accepted = accepted.event_id;
  await page.locator(`[data-event-id="${accepted.event_id}"]`).waitFor({ timeout: 30_000 });
  manifest.assertions.push('post-arm-accepted-once');

  const selfEvent = await sendMessage(room.room_id, monitor.access_token, 'self-authored');
  manifest.eventIds.selfAuthored = selfEvent.event_id;
  await waitForProcessed(page, selfEvent.event_id);
  if ((await page.locator(`[data-event-id="${selfEvent.event_id}"]`).count()) !== 0) {
    throw new Error('A self-authored event entered the developer ledger.');
  }
  manifest.assertions.push('self-authored-excluded');
  await page.screenshot({ path: resolve(artifactsDirectory, 'real-received.png'), fullPage: true });

  await page.getByRole('button', { name: 'Stop monitoring' }).click();
  const stopped = await sendMessage(room.room_id, senderB.access_token, 'stopped-window');
  manifest.eventIds.stoppedWindow = stopped.event_id;
  await waitForProcessed(page, stopped.event_id);
  if ((await page.locator(`[data-event-id="${stopped.event_id}"]`).count()) !== 0) {
    throw new Error('A stopped-window event entered the developer ledger.');
  }
  manifest.assertions.push('stopped-window-excluded');

  await page.getByRole('button', { name: 'Start monitoring' }).click();
  const rearmed = await sendMessage(room.room_id, senderB.access_token, 'rearmed');
  manifest.eventIds.rearmed = rearmed.event_id;
  await page.locator(`[data-event-id="${rearmed.event_id}"]`).waitFor({ timeout: 30_000 });
  manifest.assertions.push('rearm-accepts-only-new-activity');

  await page.reload();
  await page.getByRole('button', { name: 'Start monitoring' }).waitFor({ timeout: 45_000 });
  await page.getByText('Off', { exact: true }).first().waitFor();
  manifest.assertions.push('reload-unarmed');

  const secondPage = await context.newPage();
  await loginInBrowser(secondPage, monitor.user_id, passwords.get('monitor'));
  await secondPage.getByText('Second tab blocked').waitFor({ timeout: 30_000 });
  await secondPage.screenshot({
    path: resolve(artifactsDirectory, 'real-second-tab-blocked.png'),
    fullPage: true,
  });
  manifest.assertions.push('second-tab-blocked-before-store-open');

  await cleanupRoom(room.room_id, [monitor, senderA, senderB]);
  await context.close();
}

try {
  await main();
  manifest.result = 'pass';
} catch (error) {
  manifest.result = 'fail';
  manifest.failure = error instanceof Error ? error.message : 'Unknown local Matrix failure.';
  try {
    const logs = compose(['logs', '--no-color'], { capture: true });
    writeFileSync(resolve(artifactsDirectory, 'synapse.log'), logs);
  } catch {
    // Preserve the original failure.
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (appServer && !appServer.killed) appServer.kill('SIGTERM');
  try {
    compose(['down', '--volumes', '--remove-orphans']);
  } catch {
    // The manifest records cleanup state without hiding the primary result.
  }
  writeFileSync(
    resolve(artifactsDirectory, 'local-matrix-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  rmSync(stateDirectory, { recursive: true, force: true });
}

process.stdout.write(
  `Local Matrix scenario passed with ${manifest.assertions.length} assertions; manifest: artifacts/matrix/local-matrix-manifest.json\n`,
);
