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
