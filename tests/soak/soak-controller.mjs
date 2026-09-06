import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from '@playwright/test';

import { worktreeIdentifier } from '../../tools/worktree-identifier.mjs';

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
// A run shorter than an hour cannot establish a six-hour trend, so its growth checks are recorded
// and reported but do not decide the verdict. Everything else is judged the same either way.
const smokeRun = soakMinutes < 60;

// How much a per-item cost may rise over a shift before it reads as a leak. Half again as much
// heap, or half again as many listeners, for the same amount of retained work is not steady state.
const growthCeiling = Number.parseFloat(process.env.ACKWATCH_SOAK_GROWTH_CEILING ?? '1.5');

const manifest = {
  runId,
  plannedMinutes: soakMinutes,
  smokeRun,
  // Which tree this evidence describes. Six hours of longevity data says nothing about a build it
  // was not gathered from, and the Gate 5 report was pinning the screenshot gallery to HEAD while
  // silently accepting a soak from any commit — an asymmetry nothing could see from the manifest,
  // because the manifest did not say.
  worktreeIdentifier: worktreeIdentifier(),
  startedAt: new Date().toISOString(),
  result: 'running',
  totals: { sent: 0, accepted: 0, acknowledged: 0, completed: 0, reconnects: 0 },
  samples: 0,
  // Recorded verbatim, with the failing URL where the browser reports one, so the classification
  // below stays reviewable against a stored manifest instead of costing another six-hour run.
  browserErrors: [],
  pageErrors: [],
  checks: [],
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

// Counts the things a leak shows up in before the heap does. `performance.memory` is deliberately
// not used: Chromium buckets and caches it unless precise memory info is enabled, which is why an
// earlier smoke run reported an identical 15,200,000 bytes in all eight samples while the queue
// grew from zero to twenty-two. CDP reports the real figure, and collecting first means the reading
// is retention rather than garbage that had not been swept yet.
async function sample(page, cdp, elapsedMs) {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
  const { metrics = [] } = await cdp.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
  const byName = new Map(metrics.map(({ name, value }) => [name, value]));
  const fromPage = await page.evaluate(() => ({
    queueCards: document.querySelectorAll('[data-item-id]').length,
    liveTimers: window.__ackwatchTimerCensus?.live,
    createdTimers: window.__ackwatchTimerCensus?.created,
  }));
  const entry = {
    at: new Date().toISOString(),
    elapsedMs,
    ...fromPage,
    usedHeapBytes: byName.get('JSHeapUsedSize'),
    listeners: byName.get('JSEventListeners'),
    nodes: byName.get('Nodes'),
    documents: byName.get('Documents'),
    frames: byName.get('Frames'),
    ...manifest.totals,
  };
  appendFileSync(samplesPath, `${JSON.stringify(entry)}\n`);
  manifest.samples += 1;
  manifest.lastSample = entry;
  persist();
  return entry;
}

// `Acknowledge` is rendered only inside the item detail dialog (`src/app/App.tsx`, `.detail-actions`)
// and never on a queue card, so acknowledging means opening an item the way an operator does. A
// top-level lookup for the button silently matches nothing, which is how an earlier smoke run
// completed 21 items and acknowledged none of them.
async function acknowledgeOnePendingItem(page) {
  const pending = page.locator(
    '[data-item-id][data-status="NEW"], [data-item-id][data-status="UNACKNOWLEDGED"]',
  );
  if ((await pending.count()) === 0) return false;

  await pending.first().getByRole('button', { name: 'View details' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });

  let acknowledged = false;
  const acknowledge = dialog.getByRole('button', { name: 'Acknowledge' });
  if (await acknowledge.isVisible().catch(() => false)) {
    await acknowledge.click();
    // The button is unrendered once the item leaves NEW/UNACKNOWLEDGED, so waiting for it to detach
    // waits for the command to have been applied rather than merely dispatched.
    await acknowledge.waitFor({ state: 'detached', timeout: 15_000 });
    acknowledged = true;
  }

  await dialog.getByRole('button', { name: 'Close details' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
  return acknowledged;
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

  // Without this flag Chromium reports a bucketed, cached heap size, so a leak and a flat session
  // are indistinguishable. It is a measurement flag only and changes nothing the app can observe.
  browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const context = await browser.newContext();

  // §8.2 asks whether timers duplicate, and nothing CDP reports answers that. Counting live handles
  // in the page is the only way to see it. The wrappers preserve the platform contract exactly —
  // same arguments, same returned handle — and are installed by this harness alone.
  await context.addInitScript(() => {
    const live = new Set();
    const census = {
      created: 0,
      get live() {
        return live.size;
      },
    };
    for (const [set, clear, repeats] of [
      ['setTimeout', 'clearTimeout', false],
      ['setInterval', 'clearInterval', true],
    ]) {
      const schedule = window[set].bind(window);
      const cancel = window[clear].bind(window);
      window[set] = (handler, delay, ...rest) => {
        census.created += 1;
        let handle;
        const callback =
          typeof handler === 'function'
            ? (...args) => {
                if (!repeats) live.delete(handle);
                return handler(...args);
              }
            : handler;
        handle = schedule(callback, delay, ...rest);
        live.add(handle);
        return handle;
      };
      window[clear] = (handle) => {
        live.delete(handle);
        return cancel(handle);
      };
    }
    Object.defineProperty(window, '__ackwatchTimerCensus', { value: census });
  });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  page.on('pageerror', (error) => {
    manifest.pageErrors.push({
      at: new Date().toISOString(),
      name: error.name,
      message: error.message,
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      manifest.browserErrors.push({
        at: new Date().toISOString(),
        console: message.text(),
        url: message.location().url,
      });
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

  await sample(page, cdp, 0);
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
    manifest.totals.accepted = await page.locator('[data-item-id]').count();
    if (await acknowledgeOnePendingItem(page)) {
      manifest.totals.acknowledged += 1;
      // Edge-triggered on the acknowledgement, not level-tested on the running total: this loop
      // turns every second, so testing the total on each pass completes an item every second for
      // as long as the count sits on a multiple of three — and completes on every pass while it
      // is still zero, which is the defect this replaces.
      if (manifest.totals.acknowledged % 3 === 0) {
        const complete = page.locator('[data-item-id]').getByRole('button', { name: 'Complete' });
        if (
          await complete
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          await complete
            .first()
            .click()
            .catch(() => undefined);
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
      await sample(page, cdp, now - startedAt);
      nextSample = now + sampleIntervalMs;
    }

    await new Promise((r) => setTimeout(r, 1_000));
  }

  const final = await sample(page, cdp, Date.now() - startedAt);
  await page.screenshot({ path: resolve(artifactsDirectory, 'soak-final.png'), fullPage: true });

  const readings = readFileSync(samplesPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  // A shift accumulates work on purpose: items stay in the queue, and completed ones stay in
  // history until an explicit cleanup. So heap, listeners and DOM nodes are all *supposed* to grow
  // roughly in step with the queue, and a raw ratio would fail an honest six-hour run on its own
  // success — a thousand items cannot cost what seventeen do. What a leak looks like is cost per
  // retained item rising, so those three are normalized by queue depth and it is the normalized
  // figure that is judged. Timers and documents are per-application, not per-item, and are judged
  // absolutely: nothing about working the queue should add either.
  const baseline = readings.find(({ queueCards }) => queueCards >= 5) ?? readings[1] ?? readings[0];
  const growth = (key, { perCard = false } = {}) => {
    const from = baseline?.[key];
    const to = final?.[key];
    if (typeof from !== 'number' || typeof to !== 'number') return undefined;
    const scale = (value, { queueCards }) => (perCard ? value / Math.max(queueCards, 1) : value);
    const scaledFrom = scale(from, baseline);
    const scaledTo = scale(to, final);
    return {
      from,
      to,
      ...(perCard
        ? {
            perCardFrom: Number(scaledFrom.toFixed(1)),
            perCardTo: Number(scaledTo.toFixed(1)),
            overCards: `${baseline.queueCards} → ${final.queueCards}`,
          }
        : {}),
      ratio: Number((scaledTo / Math.max(scaledFrom, Number.EPSILON)).toFixed(2)),
    };
  };
  manifest.growth = {
    heap: growth('usedHeapBytes', { perCard: true }),
    listeners: growth('listeners', { perCard: true }),
    nodes: growth('nodes', { perCard: true }),
    liveTimers: growth('liveTimers'),
    documents: growth('documents'),
  };
  manifest.heap = manifest.growth.heap
    ? {
        firstBytes: manifest.growth.heap.from,
        lastBytes: manifest.growth.heap.to,
        peakBytes: Math.max(
          ...readings.map(({ usedHeapBytes }) => usedHeapBytes).filter(Number.isFinite),
        ),
        growthRatio: manifest.growth.heap.ratio,
      }
    : { note: 'Chromium did not report JSHeapUsedSize over CDP.' };
  manifest.finalQueueCards = final.queueCards;

  // Console errors are recorded verbatim and judged by the Gate 5 report, not here. `TESTING.md`
  // states the rule for the Matrix run and the reason for it: judging them in the report keeps the
  // list reviewable against a stored manifest instead of costing another run. That reason is far
  // stronger for a six-hour soak than for a six-minute scenario, and this controller originally
  // got it wrong — one misjudged line failed a completed run that was healthy in every other
  // respect, and re-deciding it would have meant another six hours.

  const check = (name, passed, detail, { advisory = false } = {}) =>
    manifest.checks.push({
      name,
      status: passed ? 'pass' : 'fail',
      ...(advisory && !passed ? { advisory: true } : {}),
      detail,
    });
  // Nothing about a leak is visible in a three-minute run, so growth is recorded but not decisive
  // there. Whether the run exercised the workflow at all is decisive at any length.
  const trend = { advisory: smokeRun };
  const ratioCheck = (name, measured, label) =>
    check(
      name,
      measured === undefined || measured.ratio <= growthCeiling,
      measured
        ? `${label} went ${measured.from} → ${measured.to}` +
            (measured.perCardTo === undefined
              ? ''
              : `, or ${measured.perCardFrom} → ${measured.perCardTo} per item over ${measured.overCards} items`) +
            ` (${measured.ratio}×, ceiling ${growthCeiling}×).`
        : `${label} was not reported by the browser.`,
      trend,
    );

  check(
    'workflowExercised',
    manifest.totals.acknowledged > 0 && manifest.totals.completed > 0,
    `${manifest.totals.acknowledged} acknowledged and ${manifest.totals.completed} completed of ${manifest.totals.sent} sent.`,
  );
  check(
    'reconnected',
    manifest.totals.reconnects > 0,
    `${manifest.totals.reconnects} connection drops were injected and recovered.`,
  );
  check(
    'noPageErrors',
    manifest.pageErrors.length === 0,
    `${manifest.pageErrors.length} uncaught page errors.`,
  );
  check(
    'consoleErrorsRecorded',
    true,
    `${manifest.browserErrors.length} console errors recorded verbatim for the Gate 5 report to classify.`,
  );
  ratioCheck('heapPerItemStable', manifest.growth.heap, 'Collected heap');
  ratioCheck('listenersPerItemStable', manifest.growth.listeners, 'Live DOM event listeners');
  ratioCheck('nodesPerItemStable', manifest.growth.nodes, 'DOM nodes');
  ratioCheck('timersStable', manifest.growth.liveTimers, 'Live timers');
  check(
    'documentsStable',
    manifest.growth.documents === undefined ||
      manifest.growth.documents.to <= manifest.growth.documents.from,
    manifest.growth.documents
      ? `Documents went ${manifest.growth.documents.from} → ${manifest.growth.documents.to}.`
      : 'Document count was not reported by the browser.',
    trend,
  );

  const decisive = manifest.checks.filter(({ status, advisory }) => status === 'fail' && !advisory);
  manifest.result = decisive.length === 0 ? 'pass' : 'fail';
  manifest.endedAt = new Date().toISOString();
  persist();
  if (decisive.length > 0) {
    throw new Error(
      `Soak checks failed: ${decisive.map(({ name, detail }) => `${name} — ${detail}`).join('; ')}`,
    );
  }
  process.stdout.write(
    `Soak finished: ${manifest.totals.sent} sent, ${manifest.totals.acknowledged} acknowledged, ` +
      `${manifest.totals.completed} completed, ${manifest.totals.reconnects} reconnects, ` +
      `${manifest.samples} samples, ${manifest.checks.length} checks.\n`,
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
