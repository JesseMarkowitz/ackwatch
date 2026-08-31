import { describe, expect, it, vi } from 'vitest';

import type {
  AccountId,
  CredentialStore,
  InstanceCoordinator,
  MatrixSessionCredentials,
} from './ports';
import { AckWatchController } from './app-controller';
import type { Clock } from '../domain/clock';
import { MatrixAuthentication } from '../infrastructure/matrix/authentication';
import { CoverageIssueRepository } from '../infrastructure/persistence/coverage-issue-repository';

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

describe('AckWatchController', () => {
  it('acquires ownership before constructing stores/runtime and starts unarmed', async () => {
    const log: string[] = [];
    const credentialStore = new MemoryCredentials();
    credentialStore.value = credentials;
    const controller = new AckWatchController({
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
