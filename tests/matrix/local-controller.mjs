import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { chromium } from '@playwright/test';
import { createClient, SyncState } from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent.js';
import { VerificationPhase, VerifierEvent } from 'matrix-js-sdk/lib/crypto-api/verification.js';

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
  // Recorded verbatim, with the failing URL where the browser reports one, so the Gate 4 report
  // can separate known rig noise from an unexplained application error.
  browserErrors: [],
};

// Which part of the scenario was running when a browser error appeared. The report allows the
// authorization failures that the deliberate account-wide logout provokes only inside that window,
// so the same failures stay unexplained anywhere else in the run.
let scenarioPhase = 'monitoring';

function recordBrowserMessage(entry) {
  manifest.browserErrors.push({ ...entry, phase: scenarioPhase });
}
let appServer;
let browser;
let activePage;
let encryptedSender;
let verificationPeer;

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

async function sendMessage(roomId, token, marker, content) {
  const transactionId = `${runId}-${marker}`;
  return await matrixRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(transactionId)}`,
    {
      method: 'PUT',
      token,
      body: content ?? { msgtype: 'm.text', body: `Synthetic ${marker} ${runId}` },
    },
  );
}

async function startEncryptedSender(session, roomId) {
  const client = createClient({
    baseUrl: homeserverUrl,
    accessToken: session.access_token,
    userId: session.user_id,
    deviceId: session.device_id,
    useAuthorizationHeader: true,
  });
  await client.initRustCrypto({ useIndexedDB: false });
  client.startClient({ initialSyncLimit: 20 });
  await waitFor(
    'independent encrypted sender synchronization',
    async () =>
      (client.getSyncState() === SyncState.Prepared ||
        client.getSyncState() === SyncState.Syncing) &&
      client.getRoom(roomId) !== null,
    45_000,
  );
  // Only the room creator holds the power level for state events. A later peer — the monitor's own
  // second device, joined for self-verification — reuses this helper against an already encrypted
  // room, so enabling encryption must stay the responsibility of whoever finds it disabled.
  if (client.getRoom(roomId)?.hasEncryptionStateEvent() !== true) {
    await client.sendStateEvent(
      roomId,
      'm.room.encryption',
      { algorithm: 'm.megolm.v1.aes-sha2' },
      '',
    );
  }
  await waitFor(
    'independent encrypted sender room state',
    async () => client.getRoom(roomId)?.hasEncryptionStateEvent() === true,
  );
  return client;
}

async function waitForReady(page) {
  const startButton = page.getByRole('button', { name: 'Start monitoring' });
  await startButton.waitFor({ state: 'visible', timeout: 45_000 });
  await Promise.race([
    waitFor('network-confirmed ready state', async () => await startButton.isEnabled(), 45_000),
    page
      .locator('.fault-banner')
      .waitFor({ state: 'visible', timeout: 45_000 })
      .then(async () => {
        throw new Error(`Startup fault: ${await page.locator('.fault-banner').innerText()}`);
      }),
  ]);
  return startButton;
}

async function sendEncryptedMessage(client, roomId, content) {
  return await client.sendEvent(roomId, 'm.room.message', content);
}

async function sendReaction(roomId, token, targetEventId, key, marker) {
  return await matrixRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${encodeURIComponent(`${runId}-${marker}`)}`,
    {
      method: 'PUT',
      token,
      body: { 'm.relates_to': { rel_type: 'm.annotation', event_id: targetEventId, key } },
    },
  );
}

async function redactEvent(roomId, token, eventId, marker) {
  return await matrixRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(`${runId}-${marker}`)}`,
    { method: 'PUT', token, body: { reason: 'Synthetic Phase 3 redaction' } },
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

async function openSettings(page) {
  const toSettings = page.getByRole('button', { name: 'Settings', exact: true });
  if ((await toSettings.count()) > 0) await toSettings.click();
  await page
    .getByRole('heading', { name: 'Alerts, this device, and your data' })
    .waitFor({ timeout: 30_000 });
}

async function openBoard(page) {
  const toBoard = page.getByRole('button', { name: 'Board', exact: true });
  if ((await toBoard.count()) > 0) await toBoard.click();
  await page.getByRole('heading', { name: 'Attention queue' }).waitFor({ timeout: 30_000 });
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
  // The scenario signs the monitor in several times over — the controller's own session, the
  // browser, and again as a fresh device after the deliberate account-wide logout — which exceeds
  // Synapse's default login burst and answers 429. Rate limiting is a homeserver behaviour this
  // suite does not qualify, so the disposable instance runs without it.
  appendFileSync(
    resolve(stateDirectory, 'homeserver.yaml'),
    `\npublic_baseurl: "${homeserverUrl}/"\nsuppress_key_server_warning: true\n` +
      `rc_login:\n  address:\n    per_second: 1000\n    burst_count: 1000\n` +
      `  account:\n    per_second: 1000\n    burst_count: 1000\n` +
      `  failed_attempts:\n    per_second: 1000\n    burst_count: 1000\n` +
      `rc_message:\n  per_second: 1000\n  burst_count: 1000\n` +
      `rc_registration:\n  per_second: 1000\n  burst_count: 1000\n`,
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
  activePage = page;
  page.on('pageerror', (error) => {
    recordBrowserMessage({ name: error.name, message: error.message, stack: error.stack });
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    recordBrowserMessage({ console: message.text(), url: message.location().url });
  });
  await loginInBrowser(page, monitor.user_id, passwords.get('monitor'));
  const startButton = await waitForReady(page);
  if ((await page.locator(`[data-event-id="${baseline.event_id}"]`).count()) !== 0) {
    throw new Error('The pre-arm baseline event entered the developer ledger.');
  }
  manifest.assertions.push('baseline-excluded');
  await page.screenshot({ path: resolve(artifactsDirectory, 'real-ready.png'), fullPage: true });

  await openSettings(page);
  await page.getByText('Set up cross-signing, secret storage, and key backup').click();
  await page
    .getByLabel('Current Matrix password for one-time authorization')
    .fill(passwords.get('monitor'));
  await page.getByRole('button', { name: 'Create recovery and backup' }).click();
  await page.getByText('Security setup completed. Save the recovery key now.').waitFor({
    timeout: 60_000,
  });
  const recoveryKey = await page.locator('.recovery-key code').innerText();
  if (!recoveryKey) throw new Error('AckWatch did not present the generated recovery key.');
  await page.getByRole('button', { name: 'I saved it; clear from screen' }).click();
  await page
    .getByText('Key backup', { exact: true })
    .locator('..')
    .getByText('Enabled', { exact: true })
    .waitFor();
  manifest.assertions.push('cross-signing-secret-storage-key-backup-setup');
  await openBoard(page);

  await startButton.click();
  await page.getByText('Monitoring armed', { exact: true }).waitFor();
  const accepted = await sendMessage(room.room_id, senderA.access_token, 'post-arm');
  manifest.eventIds.accepted = accepted.event_id;
  await page.locator(`[data-event-id="${accepted.event_id}"]`).waitFor({ timeout: 30_000 });
  manifest.assertions.push('post-arm-accepted-once');

  const acceptedCard = page.locator(`[data-event-id="${accepted.event_id}"]`);
  await acceptedCard.getByRole('button', { name: 'View details' }).click();
  const detail = page.getByRole('dialog');
  await page.screenshot({ path: resolve(artifactsDirectory, 'real-detail.png'), fullPage: true });
  await detail.getByRole('button', { name: 'Acknowledge' }).click();
  await detail.getByText('ACKNOWLEDGED', { exact: true }).waitFor();
  manifest.assertions.push('view-and-acknowledge');
  await detail.getByRole('button', { name: 'Close details' }).click();

  const editedBody = `Edited synthetic activity ${runId}`;
  const edit = await sendMessage(room.room_id, senderA.access_token, 'edit', {
    msgtype: 'm.text',
    body: `* ${editedBody}`,
    'm.new_content': { msgtype: 'm.text', body: editedBody },
    'm.relates_to': { rel_type: 'm.replace', event_id: accepted.event_id },
  });
  manifest.eventIds.edit = edit.event_id;
  await page.getByText(editedBody, { exact: true }).waitFor({ timeout: 30_000 });
  manifest.assertions.push('edit-updates-without-new-item');

  const redaction = await redactEvent(
    room.room_id,
    senderA.access_token,
    accepted.event_id,
    'redact-root',
  );
  manifest.eventIds.redaction = redaction.event_id;
  await page.getByText('Message removed', { exact: true }).waitFor({ timeout: 30_000 });
  manifest.assertions.push('redaction-preserves-item');

  const threadReply = await sendMessage(room.room_id, senderB.access_token, 'thread-reply', {
    msgtype: 'm.text',
    body: `Synthetic thread reply ${runId}`,
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: accepted.event_id,
      is_falling_back: true,
      'm.in_reply_to': { event_id: accepted.event_id },
    },
  });
  manifest.eventIds.threadReply = threadReply.event_id;
  const threadCard = page.locator(`[data-event-id="${threadReply.event_id}"]`);
  await threadCard.waitFor({ timeout: 30_000 });
  await threadCard.getByRole('button', { name: 'Review new activity' }).click();
  await threadCard.getByRole('button', { name: 'Complete' }).click();
  await page
    .locator('.queue-column')
    .filter({ has: page.getByRole('heading', { name: 'Completed history' }) })
    .locator(`[data-event-id="${threadReply.event_id}"]`)
    .waitFor({ timeout: 30_000 });
  await page.screenshot({
    path: resolve(artifactsDirectory, 'real-completed.png'),
    fullPage: true,
  });
  manifest.assertions.push('thread-merge-review-complete');

  const reopenedReply = await sendMessage(room.room_id, senderB.access_token, 'thread-reopen', {
    msgtype: 'm.text',
    body: `Synthetic reopen reply ${runId}`,
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: accepted.event_id,
      is_falling_back: true,
      'm.in_reply_to': { event_id: accepted.event_id },
    },
  });
  manifest.eventIds.reopenedReply = reopenedReply.event_id;
  const reopenedCard = page.locator(`[data-event-id="${reopenedReply.event_id}"]`);
  await reopenedCard.waitFor({ timeout: 30_000 });
  await reopenedCard.getByText('Needs attention', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifactsDirectory, 'real-reopened.png'), fullPage: true });
  manifest.assertions.push('completed-thread-reopens-new-cycle');

  const selfEvent = await sendMessage(room.room_id, monitor.access_token, 'self-authored');
  manifest.eventIds.selfAuthored = selfEvent.event_id;
  await waitForProcessed(page, selfEvent.event_id);
  if ((await page.locator(`[data-event-id="${selfEvent.event_id}"]`).count()) !== 0) {
    throw new Error('A self-authored event became work.');
  }
  // EVT-011: it is retained, not ingested-and-hidden — but only where a conversation covers it,
  // and an independent message of the operator's covers none, so nothing is stored for this one.
  manifest.assertions.push('self-authored-creates-no-work');
  await page.screenshot({ path: resolve(artifactsDirectory, 'real-received.png'), fullPage: true });

  // EVT-011 against a real homeserver: the operator's own reply inside a tracked conversation is
  // kept and shown in that item's history, and moves nothing about the item.
  const contextRoot = await sendMessage(room.room_id, senderB.access_token, 'context-root');
  manifest.eventIds.contextRoot = contextRoot.event_id;
  const contextCard = page.locator(`[data-event-id="${contextRoot.event_id}"]`);
  await contextCard.waitFor({ timeout: 30_000 });
  const ownReplyBody = `Synthetic own reply ${runId}`;
  const ownReply = await sendMessage(room.room_id, monitor.access_token, 'own-reply', {
    msgtype: 'm.text',
    body: ownReplyBody,
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: contextRoot.event_id,
      is_falling_back: true,
      'm.in_reply_to': { event_id: contextRoot.event_id },
    },
  });
  manifest.eventIds.ownReply = ownReply.event_id;
  await waitForProcessed(page, ownReply.event_id);
  if ((await page.locator(`[data-event-id="${ownReply.event_id}"]`).count()) !== 0) {
    throw new Error("The operator's own reply was promoted to the newest activity on a card.");
  }
  await contextCard.getByRole('button', { name: 'View details' }).click();
  const contextDialog = page.getByRole('dialog');
  // The history list specifically. The dialog also renders the newest message of the conversation
  // in full, which is now the operator's own reply, so an unscoped match finds it twice.
  await contextDialog
    .locator('.detail-activity-list')
    .getByText(ownReplyBody)
    .waitFor({ timeout: 15_000 });
  await page.screenshot({
    path: resolve(artifactsDirectory, 'real-own-context.png'),
    fullPage: true,
  });
  await contextDialog.getByRole('button', { name: 'Close details' }).click();
  manifest.assertions.push('own-reply-kept-as-context-without-becoming-work');

  // EVT-009 against a real homeserver, in both directions, and the case the change was made for:
  // a reaction to the operator's own message, which never had an item of its own.
  const ownForReaction = await sendMessage(room.room_id, monitor.access_token, 'own-reacted-to');
  manifest.eventIds.ownReactedTo = ownForReaction.event_id;
  await waitForProcessed(page, ownForReaction.event_id);
  const theirReaction = await sendReaction(
    room.room_id,
    senderB.access_token,
    ownForReaction.event_id,
    '\u{1F44D}',
    'their-reaction',
  );
  manifest.eventIds.theirReaction = theirReaction.event_id;
  // Keyed by the reaction, because the reaction is the activity that made this work: the message
  // it annotates is the operator's own and never became an activity of its own.
  const reactionCard = page.locator(`[data-event-id="${theirReaction.event_id}"]`);
  await reactionCard.waitFor({ timeout: 30_000 });
  await reactionCard.getByText('Needs attention', { exact: true }).waitFor();
  await page.screenshot({
    path: resolve(artifactsDirectory, 'real-reaction.png'),
    fullPage: true,
  });
  manifest.assertions.push('reaction-to-own-message-becomes-work');

  // A second reaction joins that work rather than arriving as another card.
  const cardsBefore = await page.locator('[data-item-id]').count();
  const secondReaction = await sendReaction(
    room.room_id,
    senderB.access_token,
    ownForReaction.event_id,
    '\u{1F389}',
    'second-reaction',
  );
  manifest.eventIds.secondReaction = secondReaction.event_id;
  await waitForProcessed(page, secondReaction.event_id);
  if ((await page.locator('[data-item-id]').count()) !== cardsBefore) {
    throw new Error('A second reaction to the same message created another queue item.');
  }
  manifest.assertions.push('reactions-group-with-the-message-they-annotate');

  // The operator's own reaction is context and must never become work.
  const ownReaction = await sendReaction(
    room.room_id,
    monitor.access_token,
    contextRoot.event_id,
    '\u2705',
    'own-reaction',
  );
  manifest.eventIds.ownReaction = ownReaction.event_id;
  await waitForProcessed(page, ownReaction.event_id);
  if ((await page.locator(`[data-event-id="${ownReaction.event_id}"]`).count()) !== 0) {
    throw new Error("The operator's own reaction became work.");
  }
  manifest.assertions.push('own-reaction-creates-no-work');

  // EVT-012: a message naming the operator is labelled, and ordering is untouched by it.
  const mention = await sendMessage(room.room_id, senderB.access_token, 'mention', {
    msgtype: 'm.text',
    body: `${monitor.user_id} can you take this ${runId}`,
    'm.mentions': { user_ids: [monitor.user_id] },
  });
  manifest.eventIds.mention = mention.event_id;
  const mentionCard = page.locator(`[data-event-id="${mention.event_id}"]`);
  await mentionCard.waitFor({ timeout: 30_000 });
  await mentionCard.getByText('Direct', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifactsDirectory, 'real-direct.png'), fullPage: true });
  manifest.assertions.push('message-naming-the-operator-is-labelled-direct');

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

  const notice = await sendMessage(room.room_id, senderA.access_token, 'notice', {
    msgtype: 'm.notice',
    body: `Synthetic notice ${runId}`,
  });
  const emote = await sendMessage(room.room_id, senderA.access_token, 'emote', {
    msgtype: 'm.emote',
    body: `reviews the handoff ${runId}`,
  });
  const imageEvent = await sendMessage(room.room_id, senderA.access_token, 'image', {
    msgtype: 'm.image',
    body: `synthetic-${runId}.png`,
    url: 'mxc://ackwatch.test/synthetic-image',
    info: { mimetype: 'image/png', size: 1234, w: 64, h: 32 },
  });
  const fileEvent = await sendMessage(room.room_id, senderA.access_token, 'file', {
    msgtype: 'm.file',
    body: `synthetic-${runId}.txt`,
    filename: 'handoff.txt',
    url: 'mxc://ackwatch.test/synthetic-file',
    info: { mimetype: 'text/plain', size: 42 },
  });
  const ordinaryReply = await sendMessage(room.room_id, senderA.access_token, 'ordinary-reply', {
    msgtype: 'm.text',
    body: `Synthetic ordinary reply ${runId}`,
    'm.relates_to': { 'm.in_reply_to': { event_id: rearmed.event_id } },
  });
  for (const [name, event] of Object.entries({
    notice,
    emote,
    image: imageEvent,
    file: fileEvent,
    ordinaryReply,
  })) {
    manifest.eventIds[name] = event.event_id;
    await page.locator(`[data-event-id="${event.event_id}"]`).waitFor({ timeout: 30_000 });
  }
  const rearmedItemId = await page
    .locator(`[data-event-id="${rearmed.event_id}"]`)
    .getAttribute('data-item-id');
  const ordinaryReplyItemId = await page
    .locator(`[data-event-id="${ordinaryReply.event_id}"]`)
    .getAttribute('data-item-id');
  if (!rearmedItemId || !ordinaryReplyItemId || rearmedItemId === ordinaryReplyItemId) {
    throw new Error('An ordinary m.in_reply_to reply was incorrectly grouped as a thread.');
  }
  manifest.assertions.push('complete-message-types-and-ordinary-reply');

  encryptedSender = await startEncryptedSender(senderA, room.room_id);
  const encryptedBody = `Synthetic encrypted activity ${runId}`;
  const encryptedRoot = await sendEncryptedMessage(encryptedSender, room.room_id, {
    msgtype: 'm.text',
    body: encryptedBody,
  });
  manifest.eventIds.encryptedRoot = encryptedRoot.event_id;
  const encryptedWire = await matrixRequest(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}/event/${encodeURIComponent(encryptedRoot.event_id)}`,
    { token: senderA.access_token },
  );
  if (encryptedWire.type !== 'm.room.encrypted') {
    throw new Error('The independent sender did not produce an encrypted wire event.');
  }
  const encryptedCard = page.locator(`[data-event-id="${encryptedRoot.event_id}"]`);
  await encryptedCard.waitFor({ timeout: 45_000 });
  await encryptedCard.getByText(encryptedBody, { exact: true }).waitFor({ timeout: 45_000 });
  await encryptedCard.getByRole('button', { name: 'View details' }).click();
  await page.getByRole('dialog').getByText(encryptedBody, { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Close details' }).click();
  const encryptedRootItemId = await encryptedCard.getAttribute('data-item-id');

  const encryptedThreadBody = `Synthetic encrypted thread reply ${runId}`;
  const encryptedThread = await sendEncryptedMessage(encryptedSender, room.room_id, {
    msgtype: 'm.text',
    body: encryptedThreadBody,
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: encryptedRoot.event_id,
      is_falling_back: true,
      'm.in_reply_to': { event_id: encryptedRoot.event_id },
    },
  });
  manifest.eventIds.encryptedThread = encryptedThread.event_id;
  const encryptedThreadCard = page.locator(`[data-event-id="${encryptedThread.event_id}"]`);
  await encryptedThreadCard.waitFor({ timeout: 45_000 });
  await encryptedThreadCard
    .getByText(encryptedThreadBody, { exact: true })
    .waitFor({ timeout: 45_000 });
  const encryptedThreadItemId = await encryptedThreadCard.getAttribute('data-item-id');
  if (!encryptedRootItemId || encryptedRootItemId !== encryptedThreadItemId) {
    throw new Error('The encrypted thread reply did not group with its encrypted root.');
  }
  manifest.assertions.push('real-e2ee-text-thread-and-detail');
  await page.screenshot({
    path: resolve(artifactsDirectory, 'real-encrypted.png'),
    fullPage: true,
  });

  await page.reload();
  await page.getByRole('button', { name: 'Start monitoring' }).waitFor({ timeout: 45_000 });
  await page.getByText('Off', { exact: true }).first().waitFor();
  manifest.assertions.push('reload-unarmed');
  await page.locator(`[data-event-id="${reopenedReply.event_id}"]`).waitFor({ timeout: 30_000 });
  await page.locator(`[data-event-id="${rearmed.event_id}"]`).waitFor({ timeout: 30_000 });
  await page.locator(`[data-event-id="${encryptedThread.event_id}"]`).waitFor({ timeout: 30_000 });
  manifest.assertions.push('reload-restores-workflow');
  await openSettings(page);
  await page
    .getByText('Crypto engine', { exact: true })
    .locator('..')
    .getByText('ready', { exact: true })
    .waitFor({ timeout: 30_000 });
  manifest.assertions.push('reload-restores-persistent-crypto-device');
  await openBoard(page);

  const secondPage = await context.newPage();
  await loginInBrowser(secondPage, monitor.user_id, passwords.get('monitor'));
  await secondPage.getByText('Second tab blocked').waitFor({ timeout: 30_000 });
  await secondPage.screenshot({
    path: resolve(artifactsDirectory, 'real-second-tab-blocked.png'),
    fullPage: true,
  });
  manifest.assertions.push('second-tab-blocked-before-store-open');
  await secondPage.close();

  // The browser signed in through the UI and owns its own device and access token, so logging out
  // this controller's session would leave the monitored tab working. Invalidating every session for
  // the account is what makes the app observe M_UNKNOWN_TOKEN, and it is why the browser rejoins
  // below as a new device that must restore key backup.
  scenarioPhase = 'token-invalidated';
  await matrixRequest('/_matrix/client/v3/logout/all', {
    method: 'POST',
    token: monitor.access_token,
    body: {},
  });
  await page.getByText(/M_UNKNOWN_TOKEN/u).waitFor({ timeout: 45_000 });
  manifest.assertions.push('unknown-token-visible-and-fatal');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Connect Matrix' }).waitFor({ timeout: 30_000 });
  await loginInBrowser(page, monitor.user_id, passwords.get('monitor'));
  await waitForReady(page);
  // The replacement session is authorized again, so authorization failures stop being expected.
  scenarioPhase = 'recovered-session';
  await openSettings(page);
  await page.getByText('Restore from a recovery key').click();
  await page.getByLabel('Recovery key').fill(recoveryKey);
  await page.getByRole('button', { name: 'Restore security secrets' }).click();
  await page.getByText('Recovery key accepted; crypto status refreshed.').waitFor({
    timeout: 60_000,
  });
  await page
    .getByText('Key backup', { exact: true })
    .locator('..')
    .getByText('Enabled', { exact: true })
    .waitFor();
  manifest.assertions.push('new-device-key-backup-restore');

  const verificationSession = await login('monitor');
  verificationPeer = await startEncryptedSender(verificationSession, room.room_id);
  let peerRequest;
  verificationPeer.on(CryptoEvent.VerificationRequestReceived, (request) => {
    if (request.isSelfVerification) peerRequest = request;
  });
  await page.getByRole('button', { name: 'Verify this device' }).click();
  await waitFor('verification request at independent device', () => peerRequest !== undefined);
  await peerRequest.accept();
  await page.getByRole('button', { name: 'Start emoji verification' }).waitFor({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Start emoji verification' }).click();
  await waitFor(
    'independent SAS verifier',
    () => peerRequest.phase === VerificationPhase.Started && peerRequest.verifier !== undefined,
  );
  let peerSas;
  peerRequest.verifier.on(VerifierEvent.ShowSas, (callbacks) => {
    peerSas = callbacks;
  });
  const peerVerification = peerRequest.verifier.verify();
  await waitFor('independent SAS comparison', () => peerSas !== undefined);
  await page.getByRole('group', { name: 'Device verification code' }).waitFor({
    timeout: 30_000,
  });
  const browserEmoji = await page
    .getByRole('group', { name: 'Device verification code' })
    .locator('li')
    .allTextContents();
  const peerEmoji = peerSas.sas.emoji?.map(([symbol, name]) => `${symbol} ${name}`) ?? [];
  if (browserEmoji.join('|') !== peerEmoji.join('|')) {
    throw new Error('The independent device and AckWatch displayed different SAS emoji.');
  }
  await Promise.all([peerSas.confirm(), page.getByRole('button', { name: 'They match' }).click()]);
  await peerVerification;
  await page
    .getByText('Device verification', { exact: true })
    .locator('..')
    .getByText('done', { exact: true })
    .waitFor({ timeout: 30_000 });
  manifest.assertions.push('own-device-emoji-sas-verification');
  const replacementMonitor = await login('monitor');

  await cleanupRoom(room.room_id, [replacementMonitor, senderA, senderB]);
  await context.close();
}

try {
  await main();
  manifest.result = 'pass';
} catch (error) {
  manifest.result = 'fail';
  manifest.failure = error instanceof Error ? error.message : 'Unknown local Matrix failure.';
  try {
    await activePage?.screenshot({
      path: resolve(artifactsDirectory, 'real-failure.png'),
      fullPage: true,
    });
  } catch {
    // Preserve the original failure.
  }
  try {
    const logs = compose(['logs', '--no-color'], { capture: true });
    writeFileSync(resolve(artifactsDirectory, 'synapse.log'), logs);
  } catch {
    // Preserve the original failure.
  }
  throw error;
} finally {
  encryptedSender?.stopClient();
  verificationPeer?.stopClient();
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
