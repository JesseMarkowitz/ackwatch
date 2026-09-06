import 'fake-indexeddb/auto';

import { describe, expect, it, vi } from 'vitest';

import type {
  AccountId,
  CredentialStore,
  InstanceCoordinator,
  MatrixSessionCredentials,
} from './ports';
import { AckWatchController } from './app-controller';
import type { Clock } from '../domain/clock';
import type { NormalizationResult } from '../domain/ingestion';
import { MatrixAuthentication } from '../infrastructure/matrix/authentication';
import { CoverageIssueRepository } from '../infrastructure/persistence/coverage-issue-repository';
import { WorkflowRepository } from '../infrastructure/persistence/workflow-repository';

const clock: Clock = { now: () => 50_000 };
const credentials: MatrixSessionCredentials = {
  accountId: '@monitor:example.test|https://example.test' as AccountId,
  baseUrl: 'https://example.test',
  userId: '@monitor:example.test',
  deviceId: 'DEVICE',
  accessToken: 'access',
};

class MemoryCredentials implements CredentialStore {
  public value: MatrixSessionCredentials | undefined;

  public async read() {
    return this.value;
  }

  public async write(value: MatrixSessionCredentials) {
    this.value = value;
  }

  public async clear() {
    this.value = undefined;
  }
}

function availableCoordinator(log: string[]): InstanceCoordinator {
  return {
    acquire: async (accountId) => {
      log.push('lock');
      return { accountId, release: async () => undefined };
    },
  };
}

function durableDependencies() {
  return {
    storageHealth: {
      inspect: async () => ({ available: true, persistenceSupported: true }),
      requestPersistence: async () => ({
        available: true,
        persistenceSupported: true,
        persistent: true,
      }),
    },
    createWorkflowRepository: (onHealth: ConstructorParameters<typeof WorkflowRepository>[3]) =>
      new WorkflowRepository(`controller-${crypto.randomUUID()}`, undefined, undefined, onHealth),
    createAlertCoordinator: () => ({
      start: () => undefined,
      stop: () => undefined,
      dispatch: async () => undefined,
      prepareForMonitoring: async () => undefined,
      requestNotificationPermission: async () => undefined,
      sendTestWebhook: async () => undefined,
      sendTestAudio: async () => undefined,
      setWebhookToken: () => undefined,
      clearWebhookToken: () => undefined,
      snapshot: () => ({
        audio: 'disabled' as const,
        notifications: 'disabled' as const,
        webhook: 'disabled' as const,
      }),
    }),
  };
}

describe('AckWatchController', () => {
  it('acquires ownership before constructing stores/runtime and starts unarmed', async () => {
    const log: string[] = [];
    const credentialStore = new MemoryCredentials();
    credentialStore.value = credentials;
    const controller = new AckWatchController({
      ...durableDependencies(),
      clock,
      credentialStore,
      instanceCoordinator: availableCoordinator(log),
      createIssueRepository: () => new CoverageIssueRepository(`unused-${crypto.randomUUID()}`),
      createRuntime: (options) => {
        log.push('runtime');
        return {
          start: async () => {
            options.coverage.beginStartup();
            options.coverage.observeSync({ state: 'syncing', fromCache: false });
            options.onChange();
          },
          stop: async () => undefined,
          logout: async () => undefined,
          retryCoverageIssues: async () => undefined,
        };
      },
    });

    await controller.initialize();

    expect(log).toEqual(['lock', 'runtime']);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'active',
      coverage: { connection: 'ready', monitoring: 'off' },
    });
    controller.startMonitoring();
    expect(controller.getSnapshot().coverage.monitoring).toBe('armed');
  });

  it('projects normalized activity only after the durable workflow callback commits', async () => {
    const credentialStore = new MemoryCredentials();
    credentialStore.value = credentials;
    let onNormalized: ((result: NormalizationResult) => Promise<void>) | undefined;
    let emitAfterNormalized: (() => void) | undefined;
    const controller = new AckWatchController({
      ...durableDependencies(),
      clock,
      credentialStore,
      instanceCoordinator: availableCoordinator([]),
      createRuntime: (options) => {
        onNormalized = options.onNormalized;
        emitAfterNormalized = options.onChange;
        return {
          start: async () => {
            options.coverage.beginStartup();
            options.coverage.observeSync({ state: 'syncing', fromCache: false });
          },
          stop: async () => undefined,
          logout: async () => undefined,
          retryCoverageIssues: async () => undefined,
        };
      },
    });
    await controller.initialize();

    await onNormalized?.({
      kind: 'activity',
      accountId: credentials.accountId,
      eventId: '$durable',
      roomId: '!room:example.test',
      sender: '@sender:example.test',
      eventType: 'm.room.message',
      messageType: 'm.text',
      preview: 'Durable work',
      detectedAt: 50_000,
      localSequence: 1,
      provenance: 'live',
      contentState: 'clear',
      relationKind: 'independent',
      encrypted: false,
      attention: 'requires_attention',
      addressing: 'ambient',
    });
    emitAfterNormalized?.();

    expect(controller.getSnapshot().queueItems).toEqual([
      expect.objectContaining({ status: 'NEW', activityCount: 1 }),
    ]);
    await controller.teardown();
  });

  it('blocks a second instance before runtime/store construction', async () => {
    const credentialStore = new MemoryCredentials();
    credentialStore.value = credentials;
    const createRuntime = vi.fn();
    const controller = new AckWatchController({
      clock,
      credentialStore,
      instanceCoordinator: { acquire: async () => undefined },
      createRuntime,
    });

    await controller.initialize();

    expect(createRuntime).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'blocked' });
  });

  it('queries flows, logs in without retaining the password, and stores only credentials', async () => {
    const credentialStore = new MemoryCredentials();
    const loginRequest = vi.fn(async () => ({
      access_token: 'access',
      device_id: 'DEVICE',
      user_id: '@monitor:example.test',
    }));
    const authentication = new MatrixAuthentication(clock, () => ({
      loginFlows: async () => ({ flows: [{ type: 'm.login.password' }] }),
      loginRequest,
    }));
    const controller = new AckWatchController({
      ...durableDependencies(),
      clock,
      authentication,
      credentialStore,
      instanceCoordinator: availableCoordinator([]),
      createRuntime: (options) => ({
        start: async () => {
          options.coverage.beginStartup();
          options.coverage.observeSync({ state: 'syncing' });
        },
        stop: async () => undefined,
        logout: async () => undefined,
        retryCoverageIssues: async () => undefined,
      }),
    });

    await controller.prepareLogin('@monitor:example.test', 'https://example.test');
    await controller.login('one-use-password');

    expect(loginRequest).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'one-use-password' }),
    );
    expect(credentialStore.value).toEqual(credentials);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('one-use-password');
  });

  it('clears local credentials when signing out from a blocked second tab', async () => {
    const credentialStore = new MemoryCredentials();
    credentialStore.value = credentials;
    const controller = new AckWatchController({
      clock,
      credentialStore,
      instanceCoordinator: { acquire: async () => undefined },
    });

    await controller.initialize();
    await controller.logout();

    expect(credentialStore.value).toBeUndefined();
    expect(controller.getSnapshot().phase).toBe('signed_out');
  });
});

describe('work session lifecycle', () => {
  function sessionDependencies(databaseName: string, alertStarts: string[]) {
    const base = durableDependencies();
    return {
      ...base,
      createWorkflowRepository: (onHealth: ConstructorParameters<typeof WorkflowRepository>[3]) =>
        new WorkflowRepository(databaseName, undefined, undefined, onHealth),
      createAlertCoordinator: () => ({
        ...base.createAlertCoordinator(),
        start: () => alertStarts.push('start'),
      }),
    };
  }

  function controllerFor(databaseName: string, now: () => number, alertStarts: string[] = []) {
    const credentialStore = new MemoryCredentials();
    credentialStore.value = credentials;
    return new AckWatchController({
      ...sessionDependencies(databaseName, alertStarts),
      clock: { now },
      credentialStore,
      instanceCoordinator: availableCoordinator([]),
      createIssueRepository: () => new CoverageIssueRepository(`unused-${crypto.randomUUID()}`),
      createRuntime: (options) => ({
        start: async () => {
          options.coverage.beginStartup();
          options.coverage.observeSync({ state: 'syncing', fromCache: false });
          options.onChange();
        },
        stop: async () => undefined,
        logout: async () => undefined,
        retryCoverageIssues: async () => undefined,
      }),
    });
  }

  it('starts with no session and opens one when monitoring starts', async () => {
    const controller = controllerFor(`session-${crypto.randomUUID()}`, () => 50_000);
    await controller.initialize();
    expect(controller.getSnapshot().session.state).toBe('none');

    controller.startMonitoring();
    await vi.waitFor(() => expect(controller.getSnapshot().session.state).toBe('active'));
  });

  it('offers a recent session back without alerting or arming until the user chooses', async () => {
    const databaseName = `session-${crypto.randomUUID()}`;
    let now = 50_000;
    const first = controllerFor(databaseName, () => now);
    await first.initialize();
    first.startMonitoring();
    await vi.waitFor(() => expect(first.getSnapshot().session.state).toBe('active'));
    await first.teardown();

    // Reload one hour later, well inside the twelve hour continuity window.
    now += 60 * 60_000;
    const alertStarts: string[] = [];
    const resumed = controllerFor(databaseName, () => now, alertStarts);
    await resumed.initialize();

    expect(resumed.getSnapshot()).toMatchObject({
      session: { state: 'interrupted' },
      coverage: { monitoring: 'off' },
    });
    // Nothing may be alerted on before the session is adopted.
    expect(alertStarts).toEqual([]);

    await resumed.continueInterruptedSession();
    expect(resumed.getSnapshot().session.state).toBe('active');
    expect(alertStarts).toEqual(['start']);
    await resumed.teardown();
  });

  it('retires a session older than the continuity window and archives it first', async () => {
    const databaseName = `session-${crypto.randomUUID()}`;
    let now = 50_000;
    const first = controllerFor(databaseName, () => now);
    await first.initialize();
    first.startMonitoring();
    await vi.waitFor(() => expect(first.getSnapshot().session.state).toBe('active'));
    await first.teardown();

    // Return the next day, beyond the window.
    now += 13 * 60 * 60_000;
    const fresh = controllerFor(databaseName, () => now);
    await fresh.initialize();

    const snapshot = fresh.getSnapshot();
    expect(snapshot.session.state).toBe('active');
    expect(snapshot.session.notice).toMatch(/older than the continuity window/i);
    // The summary is produced before anything is deleted, so the archive is never empty-handed.
    expect(snapshot.session.archivedSummary).toContain('ackwatch-session-summary');
    expect(snapshot.coverage.monitoring).toBe('off');
    await fresh.teardown();
  });
});
