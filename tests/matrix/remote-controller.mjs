import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

const explicitAccounts = [
  'ACKWATCH_MATRIX_MONITOR_USER_ID',
  'ACKWATCH_MATRIX_MONITOR_PASSWORD',
  'ACKWATCH_MATRIX_SENDER_A_USER_ID',
  'ACKWATCH_MATRIX_SENDER_A_PASSWORD',
  'ACKWATCH_MATRIX_SENDER_B_USER_ID',
  'ACKWATCH_MATRIX_SENDER_B_PASSWORD',
];
const required = ['ACKWATCH_MATRIX_HOMESERVER_URL', ...explicitAccounts];
const hasHomeserver = Boolean(process.env.ACKWATCH_MATRIX_HOMESERVER_URL);
const registrationToken = process.env.ACKWATCH_MATRIX_REGISTRATION_TOKEN ?? '';
// Two ways to run: provision disposable accounts with a registration token, or use accounts the
// developer created. Provisioning is preferred because those accounts deactivate themselves after.
const provisioning = hasHomeserver && Boolean(registrationToken);
const suppliedExplicit = explicitAccounts.filter((name) => Boolean(process.env[name]));
const supplied = provisioning ? [1] : hasHomeserver ? suppliedExplicit : [];
const missing = provisioning
  ? []
  : [
      ...(hasHomeserver ? [] : ['ACKWATCH_MATRIX_HOMESERVER_URL']),
      ...explicitAccounts.filter((name) => !process.env[name]),
    ];
const artifactsDirectory = resolve('artifacts/matrix');
const manifestPath = resolve(artifactsDirectory, 'remote-matrix-manifest.json');

mkdirSync(artifactsDirectory, { recursive: true });
if (supplied.length === 0) {
  const report = {
    result: 'skipped',
    reason: 'Optional developer-provided Matrix credentials were not supplied.',
    requiredVariableNames: required,
    alternative:
      'Set ACKWATCH_MATRIX_HOMESERVER_URL and ACKWATCH_MATRIX_REGISTRATION_TOKEN to provision disposable accounts instead.',
  };
  writeFileSync(manifestPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write('SKIP: optional remote Matrix credentials were not supplied.\n');
  process.exit(0);
}
if (missing.length > 0) {
  throw new Error(`Remote Matrix configuration is incomplete; missing: ${missing.join(', ')}`);
}

const homeserverUrl = process.env.ACKWATCH_MATRIX_HOMESERVER_URL.replace(/\/$/, '');
const homeserver = new URL(homeserverUrl);
if (
  homeserver.protocol !== 'https:' &&
  !(
    homeserver.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(homeserver.hostname)
  )
) {
  throw new Error('The remote compatibility homeserver must use HTTPS unless it is loopback.');
}

const root = resolve(import.meta.dirname, '../..');
const appUrl = 'http://127.0.0.1:4176';
const runId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const provisionedPasswords = new Map();
const configuration = provisioning
  ? {
      monitor: { userId: undefined, password: undefined },
      senderA: { userId: undefined, password: undefined },
      senderB: { userId: undefined, password: undefined },
    }
  : {
      monitor: {
        userId: process.env.ACKWATCH_MATRIX_MONITOR_USER_ID,
        password: process.env.ACKWATCH_MATRIX_MONITOR_PASSWORD,
      },
      senderA: {
        userId: process.env.ACKWATCH_MATRIX_SENDER_A_USER_ID,
        password: process.env.ACKWATCH_MATRIX_SENDER_A_PASSWORD,
      },
      senderB: {
        userId: process.env.ACKWATCH_MATRIX_SENDER_B_USER_ID,
        password: process.env.ACKWATCH_MATRIX_SENDER_B_PASSWORD,
      },
    };
const manifest = {
  runId,
  mode: provisioning ? 'provisioned-disposable-accounts' : 'developer-provided-accounts',
  result: 'running',
  assertions: [],
  cleanup: [],
};
let appServer;
let browser;
let roomId;
let sessions = [];
const browserTokens = [];

async function waitFor(description, predicate, timeoutMs = 45_000) {
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

/**
 * Registers one disposable account through the registration-token flow. Synapse answers the first
 * unauthenticated attempt with the flows it accepts and a session, then usually requires a dummy
 * stage after the token is accepted.
 */
async function registerWithToken(localpartSuffix) {
  const username = `ackwatch-test-${runId}-${localpartSuffix}`;
  const password = randomBytes(24).toString('base64url');
  const attempt = async (auth) => {
    const response = await fetch(`${homeserverUrl}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, inhibit_login: false, ...(auth ? { auth } : {}) }),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };

  let current = await attempt(undefined);
  const session = current.data.session;
  if (!session) {
    throw new Error(
      `Registration did not offer a session; the homeserver may have registration disabled (${current.data.errcode ?? current.status}).`,
    );
  }

  // Use the stage the homeserver actually asks for. A server configured with
  // `registration_requires_token` offers the token stage; one with registration merely enabled
  // offers only a dummy stage, which means it is open to anyone — recorded rather than glossed
  // over, because it is a property of the server being tested against.
  const stages = new Set(
    (Array.isArray(current.data.flows) ? current.data.flows : []).flatMap((flow) =>
      Array.isArray(flow.stages) ? flow.stages : [],
    ),
  );
  const usesToken = stages.has('m.login.registration_token');
  manifest.registrationTokenRequired = usesToken;
  if (!usesToken && !manifest.assertions.includes('homeserver-registration-is-open')) {
    manifest.assertions.push('homeserver-registration-is-open');
  }

  if (usesToken) {
    current = await attempt({
      type: 'm.login.registration_token',
      token: registrationToken,
      session,
    });
  }
  if (current.status === 401) {
    current = await attempt({ type: 'm.login.dummy', session });
  }
  if (current.status !== 200 || !current.data.access_token) {
    throw new Error(
      `Disposable account registration failed (${current.data.errcode ?? current.status}: ${current.data.error ?? 'no detail'}).`,
    );
  }
  provisionedPasswords.set(current.data.user_id, password);
  return current.data;
}

async function login({ userId, password }) {
  return await matrixRequest('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: userId },
      password,
      initial_device_display_name: 'AckWatch compatibility controller',
    },
  });
}

async function sendMessage(token, marker) {
  return await matrixRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(`${runId}-${marker}`)}`,
    {
      method: 'PUT',
      token,
      body: { msgtype: 'm.text', body: `AckWatch compatibility ${marker} ${runId}` },
    },
  );
}

async function loginInBrowser(page) {
  await page.goto(appUrl);
  await page.getByLabel('Matrix user ID').fill(configuration.monitor.userId);
  await page.getByLabel('Advanced homeserver override').check();
  await page.getByLabel('Homeserver URL override').fill(homeserverUrl);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('password-form').waitFor();
  await page.getByLabel('Password').fill(configuration.monitor.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function sessionToken(page) {
  return await page.evaluate(() => {
    const serialized = sessionStorage.getItem('ackwatch.matrix-session.v1');
    if (!serialized) return undefined;
    const value = JSON.parse(serialized);
    return typeof value.accessToken === 'string' ? value.accessToken : undefined;
  });
}

async function waitForProcessed(page, eventId) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector('.queue-preview')?.getAttribute('data-last-processed-event-id') ===
      expected,
    eventId,
    { timeout: 45_000 },
  );
}

async function cleanup() {
  if (roomId) {
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
        manifest.cleanup.push('room-left-and-forgotten');
      } catch {
        manifest.cleanup.push('room-cleanup-failed');
      }
    }
  }
  // Browser sessions are logged out first: deactivation below ends every session for the account,
  // so a logout attempted afterwards would fail for a reason that is not a failure.
  for (const token of browserTokens.filter(Boolean)) {
    try {
      await matrixRequest('/_matrix/client/v3/logout', { method: 'POST', token, body: {} });
      manifest.cleanup.push('session-logged-out');
    } catch {
      manifest.cleanup.push('session-logout-failed');
    }
  }

  // Deactivate only the accounts this run created. A developer-provided account is someone's real
  // account and is never deactivated, whatever else fails.
  for (const session of sessions) {
    const password = provisionedPasswords.get(session.user_id);
    if (!provisioning || !password) continue;
    try {
      await matrixRequest('/_matrix/client/v3/account/deactivate', {
        method: 'POST',
        token: session.access_token,
        body: {
          auth: {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: session.user_id },
            password,
          },
          erase: true,
        },
      });
      manifest.cleanup.push('disposable-account-deactivated');
    } catch {
      // Left behind rather than silently claimed clean: the manifest says so, and the account
      // carries the run ID in its localpart so it can be found and removed by hand.
      manifest.cleanup.push('disposable-account-deactivation-failed');
    }
  }

  if (!provisioning) {
    for (const token of sessions.map((session) => session.access_token).filter(Boolean)) {
      try {
        await matrixRequest('/_matrix/client/v3/logout', { method: 'POST', token, body: {} });
        manifest.cleanup.push('session-logged-out');
      } catch {
        manifest.cleanup.push('session-logout-failed');
      }
    }
  }
}

async function main() {
  sessions = provisioning
    ? await Promise.all([
        registerWithToken('monitor'),
        registerWithToken('sender-a'),
        registerWithToken('sender-b'),
      ])
    : await Promise.all([
        login(configuration.monitor),
        login(configuration.senderA),
        login(configuration.senderB),
      ]);
  if (provisioning) {
    const [provisionedMonitor, provisionedA, provisionedB] = sessions;
    configuration.monitor = {
      userId: provisionedMonitor.user_id,
      password: provisionedPasswords.get(provisionedMonitor.user_id),
    };
    configuration.senderA = {
      userId: provisionedA.user_id,
      password: provisionedPasswords.get(provisionedA.user_id),
    };
    configuration.senderB = {
      userId: provisionedB.user_id,
      password: provisionedPasswords.get(provisionedB.user_id),
    };
  }
  const [monitor, senderA, senderB] = sessions;
  const room = await matrixRequest('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: senderA.access_token,
    body: {
      name: `AckWatch compatibility ${runId}`,
      preset: 'private_chat',
      invite: [monitor.user_id, senderB.user_id],
    },
  });
  roomId = room.room_id;
  for (const session of [monitor, senderB]) {
    await matrixRequest(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      token: session.access_token,
      body: {},
    });
  }
  const baseline = await sendMessage(senderA.access_token, 'baseline');

  appServer = spawn(process.execPath, ['tools/static-server.mjs', 'dist', '4176'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor('AckWatch production server', async () => (await fetch(appUrl)).ok);
  browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  await loginInBrowser(page);
  const startButton = page.getByRole('button', { name: 'Start monitoring' });
  await startButton.waitFor({ state: 'visible', timeout: 45_000 });
  await waitFor('network-confirmed ready state', async () => await startButton.isEnabled());
  browserTokens.push(await sessionToken(page));
  if ((await page.locator(`[data-event-id="${baseline.event_id}"]`).count()) !== 0) {
    throw new Error('The pre-arm baseline event entered the developer ledger.');
  }
  manifest.assertions.push('baseline-excluded');

  await startButton.click();
  const accepted = await sendMessage(senderA.access_token, 'post-arm');
  await page.locator(`[data-event-id="${accepted.event_id}"]`).waitFor({ timeout: 45_000 });
  manifest.assertions.push('post-arm-accepted-once');

  const selfEvent = await sendMessage(monitor.access_token, 'self-authored');
  await waitForProcessed(page, selfEvent.event_id);
  if ((await page.locator(`[data-event-id="${selfEvent.event_id}"]`).count()) !== 0) {
    throw new Error('A self-authored event entered the developer ledger.');
  }
  manifest.assertions.push('self-authored-excluded');

  await page.getByRole('button', { name: 'Stop monitoring' }).click();
  const stopped = await sendMessage(senderB.access_token, 'stopped-window');
  await waitForProcessed(page, stopped.event_id);
  if ((await page.locator(`[data-event-id="${stopped.event_id}"]`).count()) !== 0) {
    throw new Error('A stopped-window event entered the developer ledger.');
  }
  manifest.assertions.push('stopped-window-excluded');

  await page.getByRole('button', { name: 'Start monitoring' }).click();
  const rearmed = await sendMessage(senderB.access_token, 'rearmed');
  await page.locator(`[data-event-id="${rearmed.event_id}"]`).waitFor({ timeout: 45_000 });
  manifest.assertions.push('rearm-accepts-only-new-activity');

  await page.reload();
  await page.getByRole('button', { name: 'Start monitoring' }).waitFor({ timeout: 45_000 });
  await page.getByText('Off', { exact: true }).first().waitFor();
  manifest.assertions.push('reload-unarmed');

  const secondPage = await context.newPage();
  await loginInBrowser(secondPage);
  await secondPage.getByText('Second tab blocked').waitFor({ timeout: 45_000 });
  browserTokens.push(await sessionToken(secondPage));
  manifest.assertions.push('second-tab-blocked-before-store-open');
  await context.close();
}

try {
  await main();
  manifest.result = 'pass';
} catch (error) {
  manifest.result = 'fail';
  manifest.failure = error instanceof Error ? error.message : 'Unknown remote Matrix failure.';
  throw error;
} finally {
  if (browser) await browser.close();
  if (appServer && !appServer.killed) appServer.kill('SIGTERM');
  await cleanup();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

process.stdout.write(
  `Remote Matrix scenario passed with ${manifest.assertions.length} assertions; manifest: artifacts/matrix/remote-matrix-manifest.json\n`,
);
