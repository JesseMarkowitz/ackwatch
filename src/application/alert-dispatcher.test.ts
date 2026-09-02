import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AlertDispatcher, AlertScheduler, genericAlertPayload } from './alert-dispatcher';
import {
  WorkflowRepository,
  defaultAccountSettings,
} from '../infrastructure/persistence/workflow-repository';

const accountId = '@monitor:example.test|https://example.test';
const repositories: WorkflowRepository[] = [];

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.length = 0;
  vi.useRealTimers();
});

async function repositoryWithWork() {
  const repository = new WorkflowRepository(
    `alerts-${crypto.randomUUID()}`,
    () => crypto.randomUUID(),
    () => 1_000,
  );
  repositories.push(repository);
  await repository.open();
  await repository.putSettings({
    ...defaultAccountSettings(accountId, 1_000),
    audioEnabled: true,
  });
  await repository.acceptActivity({
    accountId,
    eventId: '$event',
    roomId: '!room:example.test',
    sender: '@private-sender:example.test',
    eventType: 'm.room.message',
    messageType: 'm.text',
    preview: 'Private message body',
    detectedAt: 1_000,
    localSequence: 1,
    provenance: 'live',
  });
  return repository;
}

describe('AlertDispatcher', () => {
  it('dispatches only after commit and persists the successful attempt', async () => {
    const repository = await repositoryWithWork();
    const payloads: unknown[] = [];
    const dispatcher = new AlertDispatcher(repository, { now: () => 1_000 }, [
      {
        kind: 'audio',
        send: async (payload) => {
          payloads.push(payload);
          return {};
        },
      },
    ]);

    await dispatcher.dispatch(accountId);

    expect(payloads).toHaveLength(1);
    expect(JSON.stringify(payloads)).not.toMatch(/Private message|private-sender|room:/u);
    const projection = await repository.projection(accountId);
    expect(projection.effects[0]?.status).toBe('delivered');
    expect(projection.deliveries[0]).toMatchObject({ status: 'delivered', attemptCount: 1 });
    expect(await repository.unsafeDatabaseForTests().alertAttempts.count()).toBe(1);
  });

  it('coalesces concurrent scheduler passes into one transport attempt', async () => {
    const repository = await repositoryWithWork();
    const send = vi.fn(async () => ({}));
    const dispatcher = new AlertDispatcher(repository, { now: () => 1_000 }, [
      { kind: 'audio', send },
    ]);

    await Promise.all([dispatcher.dispatch(accountId), dispatcher.dispatch(accountId)]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('builds a generic payload with no Matrix content identifiers', () => {
    const payload = genericAlertPayload(
      {
        id: 'effect',
        accountId,
        itemId: 'item',
        cycleId: 'cycle',
        kind: 'unacknowledged',
        stage: 2,
        dueAt: 5_000,
        status: 'pending',
      },
      {
        id: 'item',
        accountId,
        conversationKey: 'event:private',
        roomId: '!private:example.test',
        cycleId: 'cycle',
        status: 'NEW',
        activityCount: 1,
        unseenActivityCount: 1,
        needsAttention: true,
        firstDetectedAt: 1_000,
        lastActivityAt: 1_000,
        createdAt: 1_000,
        updatedAt: 1_000,
        reopenedCount: 0,
      },
      6_000,
    );

    expect(payload).toEqual({
      schema: 'ackwatch.alert.v1',
      effectId: 'effect',
      eventKind: 'unacknowledged',
      detectedAt: 1_000,
      evaluatedAt: 6_000,
      ageMs: 5_000,
      status: 'NEW',
      unseenCount: 1,
      escalationStage: 2,
    });
  });
});

describe('AlertScheduler', () => {
  it('uses one timer and evaluates on startup and browser lifecycle wake-ups', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const evaluate = vi.fn(async () => undefined);
    const scheduler = new AlertScheduler(
      evaluate,
      {
        addEventListener: (type, listener) => listeners.set(type, listener),
        removeEventListener: (type) => listeners.delete(type),
      },
      1_000,
    );

    scheduler.start();
    scheduler.start();
    expect(evaluate).toHaveBeenCalledTimes(1);
    listeners.get('focus')?.();
    listeners.get('visibilitychange')?.();
    listeners.get('pageshow')?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(evaluate).toHaveBeenCalledTimes(5);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(evaluate).toHaveBeenCalledTimes(5);
  });
});
