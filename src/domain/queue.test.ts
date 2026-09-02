import { describe, expect, it } from 'vitest';

import {
  acceptAdditionalActivity,
  applyActivityMaintenance,
  applyQueueCommand,
  compareQueueItems,
  conversationKeyFor,
  createQueueItem,
  defaultQueueSettings,
  evaluateDeadlines,
  matrixEventUri,
  mergeThreadItems,
  QueueDomainError,
  type QueueActivity,
  type QueueCommand,
  type QueueItem,
  type QueueStatus,
} from './queue';

const statuses: readonly QueueStatus[] = ['NEW', 'UNACKNOWLEDGED', 'ACKNOWLEDGED', 'COMPLETED'];
const commands = [
  'mark_viewed',
  'acknowledge',
  'review_new_activity',
  'complete',
  'manual_reopen',
] as const;

function item(status: QueueStatus = 'NEW', overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'item-a',
    accountId: '@monitor:example.test|https://example.test',
    conversationKey: 'event:!room:example.test:$event',
    roomId: '!room:example.test',
    cycleId: 'cycle-a',
    status,
    activityCount: 1,
    unseenActivityCount: status === 'NEW' ? 1 : 0,
    needsAttention: status === 'NEW',
    firstDetectedAt: 1_000,
    lastActivityAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    reopenedCount: 0,
    ...(status === 'COMPLETED'
      ? { completedAt: 2_000 }
      : {
          deadline: {
            kind: status === 'ACKNOWLEDGED' ? 'acknowledged' : 'unacknowledged',
            firstAt: status === 'ACKNOWLEDGED' ? 1_801_000 : 301_000,
            repeatEveryMs: status === 'ACKNOWLEDGED' ? 900_000 : 300_000,
          } as const,
        }),
    ...overrides,
  };
}

function command(kind: (typeof commands)[number]): QueueCommand {
  return kind === 'manual_reopen' ? { kind, at: 3_000, cycleId: 'cycle-b' } : { kind, at: 3_000 };
}

const validity: Record<
  QueueStatus,
  Record<(typeof commands)[number], 'change' | 'noop' | 'error'>
> = {
  NEW: {
    mark_viewed: 'change',
    acknowledge: 'change',
    review_new_activity: 'error',
    complete: 'change',
    manual_reopen: 'error',
  },
  UNACKNOWLEDGED: {
    mark_viewed: 'noop',
    acknowledge: 'change',
    review_new_activity: 'error',
    complete: 'change',
    manual_reopen: 'error',
  },
  ACKNOWLEDGED: {
    mark_viewed: 'noop',
    acknowledge: 'noop',
    review_new_activity: 'noop',
    complete: 'change',
    manual_reopen: 'error',
  },
  COMPLETED: {
    mark_viewed: 'error',
    acknowledge: 'error',
    review_new_activity: 'error',
    complete: 'error',
    manual_reopen: 'change',
  },
};

describe('queue command table', () => {
  for (const status of statuses) {
    for (const kind of commands) {
      it(`${status} + ${kind} => ${validity[status][kind]}`, () => {
        const before = item(status);
        const snapshot = structuredClone(before);
        const expected = validity[status][kind];
        if (expected === 'error') {
          expect(() => applyQueueCommand(before, command(kind), defaultQueueSettings, 1)).toThrow(
            QueueDomainError,
          );
        } else {
          const result = applyQueueCommand(before, command(kind), defaultQueueSettings, 1);
          expect(result.changed).toBe(expected === 'change');
        }
        expect(before).toEqual(snapshot);
      });
    }
  }
});

describe('queue cycles and deadlines', () => {
  it('creates the first cycle and increments NEW activity without sliding its deadline', () => {
    const created = createQueueItem({
      id: 'item-a',
      accountId: '@monitor:example.test|https://example.test',
      conversationKey: conversationKeyFor('!room:example.test', '$event'),
      roomId: '!room:example.test',
      eventId: '$event',
      cycleId: 'cycle-a',
      detectedAt: 1_000,
      settings: defaultQueueSettings,
    });
    const added = acceptAdditionalActivity(
      created.item,
      200_000,
      'unused',
      defaultQueueSettings,
      1,
    );

    expect(created.item).toMatchObject({
      status: 'NEW',
      activityCount: 1,
      unseenActivityCount: 1,
      deadline: { firstAt: 301_000 },
    });
    expect(added.item).toMatchObject({
      activityCount: 2,
      unseenActivityCount: 2,
      deadline: { firstAt: 301_000 },
    });
    expect(created.effects[0]?.id).toBe('item-a|cycle-a|initial|0');
  });

  it('viewing never slides the first deadline and acknowledging materializes a new one', () => {
    const viewed = applyQueueCommand(
      item('NEW'),
      { kind: 'mark_viewed', at: 200_000 },
      defaultQueueSettings,
      1,
    );
    expect(viewed.item).toMatchObject({
      status: 'UNACKNOWLEDGED',
      firstViewedAt: 200_000,
      deadline: { firstAt: 301_000 },
    });

    const acknowledged = applyQueueCommand(
      viewed.item,
      { kind: 'acknowledge', at: 250_000 },
      defaultQueueSettings,
      2,
    );
    const laterActivity = acceptAdditionalActivity(
      acknowledged.item,
      300_000,
      'unused',
      defaultQueueSettings,
      3,
    );
    expect(laterActivity.item).toMatchObject({
      status: 'ACKNOWLEDGED',
      needsAttention: true,
      deadline: { firstAt: 2_050_000 },
    });
    const reviewed = applyQueueCommand(
      laterActivity.item,
      { kind: 'review_new_activity', at: 400_000 },
      defaultQueueSettings,
      3,
    );
    expect(reviewed.item).toMatchObject({
      needsAttention: false,
      deadline: { firstAt: 2_050_000 },
    });
  });

  it('evaluates exact boundaries and materializes only the stage that is currently due', () => {
    const current = item('NEW');
    expect(evaluateDeadlines(current, 300_999)).toEqual([]);
    expect(
      evaluateDeadlines(current, 301_000).map(({ stage, dueAt }) => ({ stage, dueAt })),
    ).toEqual([{ stage: 0, dueAt: 301_000 }]);
    // Stages that elapsed unobserved are not replayed: each evaluation yields at most the one
    // alert that is due now, so the effect table cannot grow with the time spent away.
    expect(
      evaluateDeadlines(current, 901_000).map(({ stage, dueAt }) => ({ stage, dueAt })),
    ).toEqual([{ stage: 2, dueAt: 901_000 }]);
  });

  it('cannot accumulate an alert backlog across a long absence', () => {
    const current = item('NEW');
    const oneWeek = 301_000 + 7 * 24 * 60 * 60_000;
    const thirtyDays = 301_000 + 30 * 24 * 60 * 60_000;

    expect(evaluateDeadlines(current, oneWeek)).toHaveLength(1);
    expect(evaluateDeadlines(current, thirtyDays)).toHaveLength(1);
    // Re-evaluating at the same moment is idempotent: the stage is encoded in the effect ID.
    expect(evaluateDeadlines(current, thirtyDays)[0]?.id).toBe(
      evaluateDeadlines(current, thirtyDays)[0]?.id,
    );
  });

  it('completion cancels deadlines and activity reopens with a fresh cycle', () => {
    const completed = applyQueueCommand(
      item('ACKNOWLEDGED'),
      { kind: 'complete', at: 5_000 },
      defaultQueueSettings,
      2,
    );
    expect(completed.item).not.toHaveProperty('deadline');
    expect(evaluateDeadlines(completed.item, 9_000_000)).toEqual([]);

    const reopened = acceptAdditionalActivity(
      completed.item,
      10_000,
      'cycle-next',
      defaultQueueSettings,
      3,
    );
    expect(reopened.item).toMatchObject({
      status: 'NEW',
      cycleId: 'cycle-next',
      reopenedCount: 1,
      deadline: { firstAt: 310_000 },
    });
    expect(reopened.effects[0]?.id).toBe('item-a|cycle-next|reopen|0');
  });
});

describe('maintenance, ordering, URI, and thread identity', () => {
  const activity: QueueActivity = {
    id: '@monitor|$event',
    accountId: '@monitor',
    eventId: '$event',
    itemId: 'item-a',
    roomId: '!room:example.test',
    sender: '@sender:example.test',
    eventType: 'm.room.message',
    messageType: 'm.text',
    preview: 'before',
    detectedAt: 1_000,
    localSequence: 1,
    provenance: 'live',
    contentState: 'clear',
    edited: false,
    redacted: false,
    relationKind: 'independent',
  };

  it('edits, redactions, and decryption enrichment do not mutate queue counters or effects', () => {
    expect(
      applyActivityMaintenance(activity, { kind: 'apply_edit', preview: 'after' }),
    ).toMatchObject({ preview: 'after', edited: true });
    expect(applyActivityMaintenance(activity, { kind: 'apply_redaction' })).toMatchObject({
      preview: 'Message removed',
      redacted: true,
    });
    expect(
      applyActivityMaintenance(
        { ...activity, contentState: 'encrypted_placeholder' },
        { kind: 'enrich_decrypted_content', preview: 'clear' },
      ),
    ).toMatchObject({ preview: 'clear', contentState: 'clear' });
    expect(
      applyActivityMaintenance(activity, {
        kind: 'record_decryption_failure',
        reasonCode: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID',
      }),
    ).toMatchObject({
      contentState: 'unavailable',
      decryptionFailureCode: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID',
    });
  });

  it('uses stable ID tie-breaking and only emits matrix: event URIs', () => {
    const sorted = [item('NEW', { id: 'b' }), item('NEW', { id: 'a' })].sort(compareQueueItems);
    expect(sorted.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(matrixEventUri('!room:example.test', '$event/opaque')).toBe(
      'matrix:roomid/room%3Aexample.test/e/event%2Fopaque',
    );
    expect(matrixEventUri('!room:example.test', '$event')).not.toContain('matrix.to');
  });

  it.each([
    [
      'root-first',
      item('NEW', { id: 'root', createdAt: 1_000 }),
      item('NEW', { id: 'reply', createdAt: 2_000 }),
    ],
    [
      'reply-first',
      item('NEW', { id: 'reply', createdAt: 2_000 }),
      item('NEW', { id: 'root', createdAt: 1_000 }),
    ],
  ] as const)('merges a racing thread deterministically: %s', (_label, left, right) => {
    const activities = [
      { ...activity, id: 'a-root', eventId: '$root', itemId: 'root' },
      { ...activity, id: 'a-reply', eventId: '$reply', itemId: 'reply', localSequence: 2 },
      { ...activity, id: 'a-reply', eventId: '$reply', itemId: 'reply', localSequence: 2 },
    ];
    const result = mergeThreadItems({
      left,
      right,
      activities,
      transitions: [],
      effects: [
        {
          id: 'root|cycle-a|initial|0',
          accountId: '@monitor:example.test|https://example.test',
          itemId: 'root',
          cycleId: 'cycle-a',
          kind: 'initial',
          stage: 0,
          dueAt: 1_000,
          status: 'pending',
        },
        {
          id: 'reply|cycle-a|initial|0',
          accountId: '@monitor:example.test|https://example.test',
          itemId: 'reply',
          cycleId: 'cycle-a',
          kind: 'initial',
          stage: 0,
          dueAt: 2_000,
          status: 'pending',
        },
      ],
      threadConversationKey: 'thread:!room:example.test:$root',
      rootEventId: '$root',
      at: 3_000,
      transitionSequence: 1,
    });

    expect(result.item).toMatchObject({ id: 'root', activityCount: 2 });
    expect(result.activities.map(({ itemId }) => itemId)).toEqual(['root', 'root']);
    expect(result.effects.filter(({ status }) => status === 'pending')).toHaveLength(1);
  });
});

describe('deterministic sequence replay', () => {
  it('maintains invariants across generated command/activity sequences', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      let current = item('NEW', { id: `item-${seed}` });
      for (let step = 1; step <= 50; step += 1) {
        const choice = (seed * 1_103_515_245 + step * 12_345) >>> 0;
        if (choice % 3 === 0) {
          current = acceptAdditionalActivity(
            current,
            2_000 + step,
            `cycle-${seed}-${step}`,
            defaultQueueSettings,
            step,
          ).item;
        } else if (current.status !== 'COMPLETED') {
          current = applyQueueCommand(
            current,
            { kind: 'complete', at: 2_000 + step },
            defaultQueueSettings,
            step,
          ).item;
        } else {
          current = applyQueueCommand(
            current,
            { kind: 'manual_reopen', at: 2_000 + step, cycleId: `cycle-${seed}-${step}` },
            defaultQueueSettings,
            step,
          ).item;
        }
        expect(current.activityCount).toBeGreaterThanOrEqual(current.unseenActivityCount);
        expect(current.reopenedCount).toBeGreaterThanOrEqual(0);
        expect(current.status === 'COMPLETED').toBe(!current.deadline);
      }
    }
  });
});
