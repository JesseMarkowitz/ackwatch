import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import type { QueueStatus } from '../../domain/queue';
import {
  WorkflowRepository,
  defaultAccountSettings,
  type AcceptedActivityInput,
  type PersistenceFaultPoint,
  type StorageHealth,
} from './workflow-repository';

const accountId = '@monitor:example.test|https://example.test';
const repositories: WorkflowRepository[] = [];

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.length = 0;
});

function ids() {
  let value = 0;
  return () => `generated-${++value}`;
}

function activity(
  eventId = '$event',
  overrides: Partial<AcceptedActivityInput> = {},
): AcceptedActivityInput {
  return {
    accountId,
    eventId,
    roomId: '!room:example.test',
    sender: '@sender:example.test',
    eventType: 'm.room.message',
    messageType: 'm.text',
    preview: `Preview ${eventId}`,
    detectedAt: 1_000,
    localSequence: 1,
    provenance: 'live',
    ...overrides,
  };
}

async function createRepository(name = `workflow-${crypto.randomUUID()}`) {
  const repository = new WorkflowRepository(name, ids(), () => 50_000);
  repositories.push(repository);
  await repository.open();
  return repository;
}

describe('WorkflowRepository atomic acceptance', () => {
  it('commits the activity, item, conversation, transition, and effect exactly once', async () => {
    const repository = await createRepository();

    await expect(repository.acceptActivity(activity())).resolves.toMatchObject({
      status: 'accepted',
    });
    await expect(repository.acceptActivity(activity())).resolves.toEqual({ status: 'duplicate' });
    const projection = await repository.projection(accountId);

    expect(projection.items).toHaveLength(1);
    expect(projection.activities).toHaveLength(1);
    expect(projection.transitions).toHaveLength(1);
    expect(projection.effects).toEqual([
      expect.objectContaining({ kind: 'initial', status: 'pending' }),
    ]);
  });

  it('serializes concurrent duplicate insertion using the account/event identity', async () => {
    const repository = await createRepository();
    const results = await Promise.all([
      repository.acceptActivity(activity()),
      repository.acceptActivity(activity()),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['accepted', 'duplicate']);
    expect((await repository.projection(accountId)).activities).toHaveLength(1);
  });

  it.each([
    'after_activity',
    'after_item',
    'after_conversation',
    'after_transition',
    'after_effect',
  ] satisfies readonly PersistenceFaultPoint[])(
    'rolls back every store after %s failure',
    async (point) => {
      const health: StorageHealth[] = [];
      const repository = new WorkflowRepository(
        `rollback-${point}-${crypto.randomUUID()}`,
        ids(),
        () => 50_000,
        (next) => health.push(next),
      );
      repositories.push(repository);
      await repository.open();

      await expect(repository.acceptActivity(activity(), point)).rejects.toThrow(/injected/i);
      const database = repository.unsafeDatabaseForTests();
      await expect(
        Promise.all([
          database.activities.count(),
          database.queueItems.count(),
          database.conversationKeys.count(),
          database.workflowTransitions.count(),
          database.alertEffects.count(),
          database.settings.count(),
        ]),
      ).resolves.toEqual([0, 0, 0, 0, 0, 0]);
      expect(health.at(-1)?.state).toBe('failed');
    },
  );
});

describe('WorkflowRepository state, thread, and maintenance behavior', () => {
  it('durably claims, retries, exhausts, and manually retries alert delivery with stable IDs', async () => {
    const repository = await createRepository();
    await repository.acceptActivity(activity());
    const [audio, webhook] = await repository.prepareDueAlertDeliveries(accountId, 1_000, [
      'audio',
      'webhook',
    ]);
    expect([audio?.id, webhook?.id]).toEqual([
      expect.stringContaining('|audio'),
      expect.stringContaining('|webhook'),
    ]);

    const claimedAudio = await repository.claimAlertDelivery(accountId, audio?.id ?? '', 1_000);
    await repository.settleAlertDelivery(accountId, claimedAudio?.id ?? '', {
      status: 'delivered',
      at: 1_001,
    });
    const claimedWebhook = await repository.claimAlertDelivery(accountId, webhook?.id ?? '', 1_000);
    const retrying = await repository.settleAlertDelivery(accountId, claimedWebhook?.id ?? '', {
      status: 'failed',
      at: 1_001,
      errorCode: 'HTTP_503',
      retryable: true,
      maxAttempts: 2,
      responseStatus: 503,
    });
    expect(retrying).toMatchObject({ status: 'pending', nextAttemptAt: 2_001, attemptCount: 1 });
    await expect(
      repository.claimAlertDelivery(accountId, retrying.id, 2_000),
    ).resolves.toBeUndefined();
    await repository.claimAlertDelivery(accountId, retrying.id, 2_001);
    const exhausted = await repository.settleAlertDelivery(accountId, retrying.id, {
      status: 'failed',
      at: 2_002,
      errorCode: 'HTTP_503',
      retryable: true,
      maxAttempts: 2,
      responseStatus: 503,
    });
    expect(exhausted.status).toBe('exhausted');
    expect((await repository.projection(accountId)).effects[0]?.status).toBe('delivered');

    await repository.retryAlertDelivery(accountId, retrying.id, 3_000);
    const manual = await repository.claimAlertDelivery(accountId, retrying.id, 3_000);
    expect(manual).toMatchObject({ id: retrying.id, attemptCount: 3 });
  });

  it('reclaims an alert delivery only after its crash lease expires', async () => {
    const repository = await createRepository();
    await repository.acceptActivity(activity());
    const [delivery] = await repository.prepareDueAlertDeliveries(accountId, 1_000, ['webhook']);
    await repository.claimAlertDelivery(accountId, delivery?.id ?? '', 1_000, 500);

    expect(await repository.prepareDueAlertDeliveries(accountId, 1_499, ['webhook'])).toEqual([]);
    expect(await repository.prepareDueAlertDeliveries(accountId, 1_500, ['webhook'])).toEqual([
      expect.objectContaining({ id: delivery?.id, status: 'delivering' }),
    ]);
    expect(
      await repository.claimAlertDelivery(accountId, delivery?.id ?? '', 1_500, 500),
    ).toMatchObject({ attemptCount: 2 });
  });

  it('materializes each due deadline effect once and cancels pending effects on completion', async () => {
    const repository = await createRepository();
    const accepted = await repository.acceptActivity(activity());
    const itemId = accepted.itemId as string;

    await expect(repository.evaluateDeadlines(accountId, 300_999)).resolves.toBe(0);
    await expect(repository.evaluateDeadlines(accountId, 301_000)).resolves.toBe(1);
    await expect(repository.evaluateDeadlines(accountId, 901_000)).resolves.toBe(2);
    await expect(repository.evaluateDeadlines(accountId, 901_000)).resolves.toBe(0);

    await repository.applyCommand(accountId, itemId, { kind: 'complete', at: 902_000 });
    const projection = await repository.projection(accountId);
    expect(projection.effects).toHaveLength(4);
    expect(projection.effects.every(({ status }) => status === 'cancelled')).toBe(true);
  });

  it('cancels materialized unacknowledged deliveries when the item is acknowledged', async () => {
    const repository = await createRepository();
    const accepted = await repository.acceptActivity(activity());
    const itemId = accepted.itemId as string;
    await repository.prepareDueAlertDeliveries(accountId, 301_000, ['webhook']);

    await repository.applyCommand(accountId, itemId, { kind: 'acknowledge', at: 301_001 });

    const projection = await repository.projection(accountId);
    const unacknowledged = projection.effects.find(({ kind }) => kind === 'unacknowledged');
    expect(unacknowledged?.status).toBe('cancelled');
    expect(
      projection.deliveries.find(({ effectId }) => effectId === unacknowledged?.id),
    ).toMatchObject({ status: 'exhausted', lastErrorCode: 'EFFECT_CANCELLED' });
    expect(projection.effects.find(({ kind }) => kind === 'initial')?.status).toBe('pending');
  });

  it('rolls back a rejected command without changing persisted workflow state', async () => {
    const repository = await createRepository();
    const accepted = await repository.acceptActivity(activity());
    const itemId = accepted.itemId as string;
    await repository.applyCommand(accountId, itemId, { kind: 'complete', at: 2_000 });
    const before = await repository.projection(accountId);

    await expect(
      repository.applyCommand(accountId, itemId, { kind: 'acknowledge', at: 3_000 }),
    ).rejects.toThrow(/not available/i);

    expect(await repository.projection(accountId)).toEqual(before);
  });

  it('restores NEW, UNACKNOWLEDGED, ACKNOWLEDGED, and COMPLETED states after reopen', async () => {
    for (const targetStatus of [
      'NEW',
      'UNACKNOWLEDGED',
      'ACKNOWLEDGED',
      'COMPLETED',
    ] satisfies readonly QueueStatus[]) {
      const name = `restore-${targetStatus}-${crypto.randomUUID()}`;
      const first = await createRepository(name);
      const accepted = await first.acceptActivity(activity(`$${targetStatus}`));
      const itemId = accepted.itemId as string;
      if (targetStatus === 'UNACKNOWLEDGED') {
        await first.applyCommand(accountId, itemId, { kind: 'mark_viewed', at: 2_000 });
      }
      if (targetStatus === 'ACKNOWLEDGED') {
        await first.applyCommand(accountId, itemId, { kind: 'acknowledge', at: 2_000 });
      }
      if (targetStatus === 'COMPLETED') {
        await first.applyCommand(accountId, itemId, { kind: 'complete', at: 2_000 });
      }
      first.close();
      repositories.splice(repositories.indexOf(first), 1);

      const reopened = new WorkflowRepository(name, ids(), () => 50_000);
      repositories.push(reopened);
      await reopened.open();
      expect((await reopened.projection(accountId)).items[0]?.status).toBe(targetStatus);
    }
  });

  it.each(['root-first', 'reply-first'] as const)(
    'promotes and merges a thread atomically for %s arrival',
    async (arrival) => {
      const repository = await createRepository();
      const root = activity('$root');
      const reply = activity('$reply', {
        detectedAt: 2_000,
        localSequence: 2,
        relationKind: 'thread',
        relationEventId: '$root',
      });
      for (const current of arrival === 'root-first' ? [root, reply] : [reply, root]) {
        await repository.acceptActivity(current);
      }

      const projection = await repository.projection(accountId);
      expect(projection.items).toHaveLength(1);
      expect(projection.items[0]).toMatchObject({
        conversationKey: 'thread:!room:example.test:$root',
        rootEventId: '$root',
        activityCount: 2,
      });
      expect(new Set(projection.activities.map(({ itemId }) => itemId))).toEqual(
        new Set([projection.items[0]?.id]),
      );
      expect(projection.effects.filter(({ status }) => status === 'pending')).toHaveLength(1);
    },
  );

  it('applies edit and redaction maintenance without changing workflow counts or effects', async () => {
    const repository = await createRepository();
    await repository.acceptActivity(activity());
    const before = await repository.projection(accountId);

    await expect(
      repository.applyMaintenance(accountId, '$event', {
        kind: 'apply_edit',
        preview: 'Edited preview',
      }),
    ).resolves.toBe(true);
    await repository.applyMaintenance(accountId, '$event', { kind: 'apply_redaction' });
    const after = await repository.projection(accountId);

    expect(after.activities[0]).toMatchObject({ redacted: true, preview: 'Message removed' });
    expect(after.items[0]?.activityCount).toBe(before.items[0]?.activityCount);
    expect(after.effects).toEqual(before.effects);
  });
});

describe('WorkflowRepository schemas, settings, and corruption', () => {
  it('persists the start and explicit end of a monitoring session', async () => {
    const repository = await createRepository();
    await repository.beginMonitoringSession(accountId, 'session-1', 1_000);
    await repository.endMonitoringSession('session-1', 2_000, 'user_stop');

    await expect(
      repository.unsafeDatabaseForTests().monitoringSessions.get('session-1'),
    ).resolves.toMatchObject({
      accountId,
      startedAt: 1_000,
      stoppedAt: 2_000,
      stopReason: 'user_stop',
    });
  });

  it('reports an unexpected database termination as a visible storage fault', async () => {
    const health: StorageHealth[] = [];
    const repository = new WorkflowRepository(
      `terminated-${crypto.randomUUID()}`,
      ids(),
      () => 50_000,
      (next) => health.push(next),
    );
    repositories.push(repository);
    await repository.open();

    repository.unsafeDatabaseForTests().close();

    expect(health.at(-1)).toMatchObject({ state: 'closed' });
  });

  it('migrates the released Phase 2 schema without losing its coverage issue', async () => {
    const name = `migration-v1-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(1).stores({
      coverageIssues: 'id, [accountId+status], accountId, roomId, updatedAt',
    });
    await old.open();
    await old.table('coverageIssues').add({
      id: 'coverage-1',
      accountId,
      kind: 'gap_recovery',
      roomId: '!room:example.test',
      boundaryEventId: '$boundary',
      detail: 'Recovery pending.',
      createdAt: 1_000,
      updatedAt: 1_000,
      status: 'open',
    });
    old.close();

    const repository = await createRepository(name);
    expect(
      await repository.unsafeDatabaseForTests().coverageIssues.get('coverage-1'),
    ).toMatchObject({
      status: 'open',
    });
    expect(repository.unsafeDatabaseForTests().verno).toBe(3);
  });

  it('migrates released Phase 3 settings to alert configuration defaults', async () => {
    const name = `migration-v2-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(2).stores({ settings: 'accountId, updatedAt' });
    await old.open();
    await old.table('settings').add({
      accountId,
      schemaVersion: 1,
      unacknowledgedAfterMs: 300_000,
      unacknowledgedRepeatMs: 300_000,
      acknowledgedAfterMs: 1_800_000,
      acknowledgedRepeatMs: 900_000,
      diagnosticsRetentionDays: 30,
      previewPrivacy: 'generic',
      audioEnabled: true,
      browserNotificationsEnabled: false,
      webhookEnabled: false,
      updatedAt: 1_000,
    });
    old.close();

    const repository = await createRepository(name);
    await expect(repository.getSettings(accountId)).resolves.toMatchObject({
      schemaVersion: 2,
      previewPrivacy: 'generic',
      audioEnabled: true,
      audioVolume: 0.8,
      webhookPreset: 'generic',
      webhookMaxAttempts: 5,
    });
  });

  it('round-trips account settings separately and disables webhook on import', async () => {
    const source = await createRepository();
    await source.putSettings({
      ...defaultAccountSettings(accountId, 1_000),
      previewPrivacy: 'generic',
      webhookEnabled: true,
    });
    const exported = await source.exportSettings(accountId);
    expect(exported).not.toContain('password');
    expect(exported).not.toContain('token');

    const target = await createRepository();
    const imported = await target.importSettings(
      '@other:example.test|https://example.test',
      exported,
    );
    expect(imported).toMatchObject({
      accountId: '@other:example.test|https://example.test',
      previewPrivacy: 'generic',
      webhookEnabled: false,
    });
  });

  it('imports a released Phase 3 settings export without enabling its webhook', async () => {
    const repository = await createRepository();
    const legacy = JSON.stringify({
      kind: 'ackwatch-settings',
      version: 1,
      settings: {
        accountId,
        schemaVersion: 1,
        unacknowledgedAfterMs: 60_000,
        unacknowledgedRepeatMs: 60_000,
        acknowledgedAfterMs: 120_000,
        acknowledgedRepeatMs: 120_000,
        diagnosticsRetentionDays: 14,
        previewPrivacy: 'generic',
        audioEnabled: true,
        browserNotificationsEnabled: true,
        webhookEnabled: true,
        updatedAt: 1_000,
      },
    });

    await expect(repository.importSettings(accountId, legacy)).resolves.toMatchObject({
      schemaVersion: 2,
      previewPrivacy: 'generic',
      webhookEnabled: false,
      webhookPreset: 'generic',
    });
  });

  it('quarantines an invalid record by shape and reports corrupt storage health', async () => {
    const health: StorageHealth[] = [];
    const repository = new WorkflowRepository(
      `corrupt-${crypto.randomUUID()}`,
      ids(),
      () => 50_000,
      (next) => health.push(next),
    );
    repositories.push(repository);
    await repository.open();
    await repository.unsafeDatabaseForTests().queueItems.add({
      id: 'corrupt-item',
      accountId,
      conversationKey: 'bad',
      roomId: 'not-a-room-id',
      cycleId: 'cycle',
      status: 'NEW',
      activityCount: 0,
      unseenActivityCount: 0,
      needsAttention: false,
      firstDetectedAt: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0,
      reopenedCount: 0,
    });

    const projection = await repository.projection(accountId);
    expect(projection.items).toEqual([]);
    expect(projection.quarantineCount).toBe(1);
    expect(health.at(-1)?.state).toBe('corrupt');
    const quarantine = await repository.unsafeDatabaseForTests().quarantine.toArray();
    expect(JSON.stringify(quarantine)).not.toContain('not-a-room-id');
  });
});
