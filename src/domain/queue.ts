export type QueueStatus = 'NEW' | 'UNACKNOWLEDGED' | 'ACKNOWLEDGED' | 'COMPLETED';

export interface QueueSettings {
  readonly unacknowledgedAfterMs: number;
  readonly unacknowledgedRepeatMs: number;
  readonly acknowledgedAfterMs: number;
  readonly acknowledgedRepeatMs: number;
}

export const defaultQueueSettings: QueueSettings = {
  unacknowledgedAfterMs: 5 * 60_000,
  unacknowledgedRepeatMs: 5 * 60_000,
  acknowledgedAfterMs: 30 * 60_000,
  acknowledgedRepeatMs: 15 * 60_000,
};

export interface MaterializedDeadline {
  readonly firstAt: number;
  readonly repeatEveryMs: number;
  readonly kind: 'unacknowledged' | 'acknowledged';
}

/**
 * The newest activity's display fields, copied onto the item so a card can render without the
 * whole activity table. Maintained by persistence; no domain rule reads or branches on it.
 */
export interface LatestActivitySummary {
  readonly eventId: string;
  readonly sender: string;
  readonly preview: string;
  readonly roomName?: string | undefined;
}

export interface QueueItem {
  readonly id: string;
  readonly accountId: string;
  readonly conversationKey: string;
  readonly roomId: string;
  readonly rootEventId?: string | undefined;
  readonly cycleId: string;
  readonly status: QueueStatus;
  readonly activityCount: number;
  readonly unseenActivityCount: number;
  readonly needsAttention: boolean;
  readonly firstDetectedAt: number;
  readonly lastActivityAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly firstViewedAt?: number | undefined;
  readonly acknowledgedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly reopenedCount: number;
  readonly deadline?: MaterializedDeadline | undefined;
  readonly latestActivity?: LatestActivitySummary | undefined;
}

export interface QueueActivity {
  readonly id: string;
  readonly accountId: string;
  readonly eventId: string;
  readonly itemId: string;
  readonly roomId: string;
  readonly sender: string;
  readonly eventType: string;
  readonly messageType: string;
  readonly preview: string;
  readonly detectedAt: number;
  readonly localSequence: number;
  readonly provenance: string;
  readonly contentState: 'clear' | 'encrypted_placeholder' | 'unavailable';
  readonly decryptionFailureCode?: string | undefined;
  readonly media?: SafeMediaMetadata | undefined;
  readonly edited: boolean;
  readonly redacted: boolean;
  readonly relationKind: 'independent' | 'thread' | 'reply';
  readonly relationEventId?: string | undefined;
  readonly roomName?: string | undefined;
}

export interface SafeMediaMetadata {
  readonly name: string;
  readonly mimeType?: string | undefined;
  readonly size?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export type ActivityMaintenanceCommand =
  | { readonly kind: 'apply_edit'; readonly preview?: string }
  | { readonly kind: 'apply_redaction' }
  | {
      readonly kind: 'enrich_decrypted_content';
      readonly preview: string;
      readonly messageType?: string;
      readonly media?: SafeMediaMetadata;
    }
  | { readonly kind: 'record_decryption_failure'; readonly reasonCode: string };

export interface WorkflowTransition {
  readonly id: string;
  readonly accountId: string;
  readonly itemId: string;
  readonly cycleId: string;
  readonly command: QueueCommand['kind'] | 'accept_activity' | 'thread_merge';
  readonly fromStatus?: QueueStatus | undefined;
  readonly toStatus: QueueStatus;
  readonly at: number;
  readonly sequence: number;
  readonly sourceItemId?: string | undefined;
}

export interface AlertEffect {
  readonly id: string;
  readonly accountId: string;
  readonly itemId: string;
  readonly cycleId: string;
  readonly kind: 'initial' | 'reopen' | 'unacknowledged' | 'acknowledged';
  readonly stage: number;
  readonly dueAt: number;
  readonly status: 'pending' | 'delivered' | 'cancelled';
}

export type QueueCommand =
  | { readonly kind: 'mark_viewed'; readonly at: number }
  | { readonly kind: 'acknowledge'; readonly at: number }
  | { readonly kind: 'review_new_activity'; readonly at: number }
  | { readonly kind: 'complete'; readonly at: number }
  | { readonly kind: 'manual_reopen'; readonly at: number; readonly cycleId: string };

export interface QueueMutation {
  readonly item: QueueItem;
  readonly transition?: WorkflowTransition;
  readonly effects: readonly AlertEffect[];
  readonly changed: boolean;
}

export class QueueDomainError extends Error {
  public constructor(
    public readonly code: 'invalid_command' | 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'QueueDomainError';
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new QueueDomainError('invalid_input', `${label} must be a non-negative safe integer.`);
  }
}

function transitionId(itemId: string, cycleId: string, sequence: number): string {
  return `${itemId}|${cycleId}|transition|${sequence}`;
}

export function alertEffectId(
  itemId: string,
  cycleId: string,
  kind: AlertEffect['kind'],
  stage: number,
): string {
  return `${itemId}|${cycleId}|${kind}|${stage}`;
}

function transitionFor(
  item: QueueItem,
  command: WorkflowTransition['command'],
  toStatus: QueueStatus,
  at: number,
  sequence: number,
  sourceItemId?: string,
): WorkflowTransition {
  return {
    id: transitionId(item.id, item.cycleId, sequence),
    accountId: item.accountId,
    itemId: item.id,
    cycleId: item.cycleId,
    command,
    fromStatus: item.status,
    toStatus,
    at,
    sequence,
    ...(sourceItemId === undefined ? {} : { sourceItemId }),
  };
}

export function conversationKeyFor(
  roomId: string,
  eventId: string,
  threadRootEventId?: string,
): string {
  return threadRootEventId ? `thread:${roomId}:${threadRootEventId}` : `event:${roomId}:${eventId}`;
}

export function matrixEventUri(roomId: string, eventId: string): string {
  if (!roomId.startsWith('!') || !eventId.startsWith('$')) {
    throw new QueueDomainError('invalid_input', 'Matrix event URIs require room and event IDs.');
  }
  return `matrix:roomid/${encodeURIComponent(roomId.slice(1))}/e/${encodeURIComponent(eventId.slice(1))}`;
}

export function createQueueItem(input: {
  readonly id: string;
  readonly accountId: string;
  readonly conversationKey: string;
  readonly roomId: string;
  readonly eventId: string;
  readonly cycleId: string;
  readonly detectedAt: number;
  readonly settings: QueueSettings;
  readonly rootEventId?: string;
}): QueueMutation {
  assertTimestamp(input.detectedAt, 'Detection time');
  const item: QueueItem = {
    id: input.id,
    accountId: input.accountId,
    conversationKey: input.conversationKey,
    roomId: input.roomId,
    ...(input.rootEventId === undefined ? {} : { rootEventId: input.rootEventId }),
    cycleId: input.cycleId,
    status: 'NEW',
    activityCount: 1,
    unseenActivityCount: 1,
    needsAttention: true,
    firstDetectedAt: input.detectedAt,
    lastActivityAt: input.detectedAt,
    createdAt: input.detectedAt,
    updatedAt: input.detectedAt,
    reopenedCount: 0,
    deadline: {
      kind: 'unacknowledged',
      firstAt: input.detectedAt + input.settings.unacknowledgedAfterMs,
      repeatEveryMs: input.settings.unacknowledgedRepeatMs,
    },
  };
  return {
    item,
    changed: true,
    transition: {
      id: transitionId(item.id, item.cycleId, 0),
      accountId: item.accountId,
      itemId: item.id,
      cycleId: item.cycleId,
      command: 'accept_activity',
      toStatus: 'NEW',
      at: input.detectedAt,
      sequence: 0,
    },
    effects: [
      {
        id: alertEffectId(item.id, item.cycleId, 'initial', 0),
        accountId: item.accountId,
        itemId: item.id,
        cycleId: item.cycleId,
        kind: 'initial',
        stage: 0,
        dueAt: input.detectedAt,
        status: 'pending',
      },
    ],
  };
}

export function acceptAdditionalActivity(
  item: QueueItem,
  detectedAt: number,
  cycleIdForReopen: string,
  settings: QueueSettings,
  transitionSequence: number,
): QueueMutation {
  assertTimestamp(detectedAt, 'Detection time');
  if (item.status === 'COMPLETED') {
    const reopened: QueueItem = {
      ...item,
      cycleId: cycleIdForReopen,
      status: 'NEW',
      activityCount: item.activityCount + 1,
      unseenActivityCount: 1,
      needsAttention: true,
      firstDetectedAt: detectedAt,
      lastActivityAt: detectedAt,
      updatedAt: detectedAt,
      reopenedCount: item.reopenedCount + 1,
      deadline: {
        kind: 'unacknowledged',
        firstAt: detectedAt + settings.unacknowledgedAfterMs,
        repeatEveryMs: settings.unacknowledgedRepeatMs,
      },
    };
    const previous = { ...item, cycleId: cycleIdForReopen };
    return {
      item: reopened,
      changed: true,
      transition: transitionFor(previous, 'accept_activity', 'NEW', detectedAt, transitionSequence),
      effects: [
        {
          id: alertEffectId(item.id, cycleIdForReopen, 'reopen', 0),
          accountId: item.accountId,
          itemId: item.id,
          cycleId: cycleIdForReopen,
          kind: 'reopen',
          stage: 0,
          dueAt: detectedAt,
          status: 'pending',
        },
      ],
    };
  }

  return {
    item: {
      ...item,
      activityCount: item.activityCount + 1,
      unseenActivityCount: item.unseenActivityCount + 1,
      needsAttention: true,
      lastActivityAt: detectedAt,
      updatedAt: detectedAt,
    },
    changed: true,
    effects: [],
  };
}

function invalid(item: QueueItem, command: QueueCommand): never {
  throw new QueueDomainError(
    'invalid_command',
    `${command.kind} is not available while the item is ${item.status}.`,
  );
}

export function applyQueueCommand(
  item: QueueItem,
  command: QueueCommand,
  settings: QueueSettings,
  transitionSequence: number,
): QueueMutation {
  assertTimestamp(command.at, 'Command time');
  if (!Number.isSafeInteger(transitionSequence) || transitionSequence < 0) {
    throw new QueueDomainError('invalid_input', 'Transition sequence must be non-negative.');
  }

  switch (command.kind) {
    case 'mark_viewed': {
      if (item.status === 'COMPLETED') return invalid(item, command);
      if (item.status !== 'NEW') return { item, effects: [], changed: false };
      const next: QueueItem = {
        ...item,
        status: 'UNACKNOWLEDGED',
        unseenActivityCount: 0,
        needsAttention: false,
        firstViewedAt: item.firstViewedAt ?? command.at,
        updatedAt: command.at,
      };
      return {
        item: next,
        changed: true,
        transition: transitionFor(item, command.kind, next.status, command.at, transitionSequence),
        effects: [],
      };
    }
    case 'acknowledge': {
      if (item.status === 'COMPLETED') return invalid(item, command);
      if (item.status === 'ACKNOWLEDGED') return { item, effects: [], changed: false };
      const next: QueueItem = {
        ...item,
        status: 'ACKNOWLEDGED',
        unseenActivityCount: 0,
        needsAttention: false,
        acknowledgedAt: command.at,
        updatedAt: command.at,
        deadline: {
          kind: 'acknowledged',
          firstAt: command.at + settings.acknowledgedAfterMs,
          repeatEveryMs: settings.acknowledgedRepeatMs,
        },
      };
      return {
        item: next,
        changed: true,
        transition: transitionFor(item, command.kind, next.status, command.at, transitionSequence),
        effects: [],
      };
    }
    case 'review_new_activity': {
      if (item.status !== 'ACKNOWLEDGED') return invalid(item, command);
      if (!item.needsAttention && item.unseenActivityCount === 0) {
        return { item, effects: [], changed: false };
      }
      return {
        item: {
          ...item,
          unseenActivityCount: 0,
          needsAttention: false,
          updatedAt: command.at,
        },
        changed: true,
        transition: transitionFor(item, command.kind, item.status, command.at, transitionSequence),
        effects: [],
      };
    }
    case 'complete': {
      if (item.status === 'COMPLETED') return invalid(item, command);
      const { deadline: _deadline, ...withoutDeadline } = item;
      void _deadline;
      const next: QueueItem = {
        ...withoutDeadline,
        status: 'COMPLETED',
        unseenActivityCount: 0,
        needsAttention: false,
        completedAt: command.at,
        updatedAt: command.at,
      };
      return {
        item: next,
        changed: true,
        transition: transitionFor(item, command.kind, next.status, command.at, transitionSequence),
        effects: [],
      };
    }
    case 'manual_reopen': {
      if (item.status !== 'COMPLETED') return invalid(item, command);
      const next: QueueItem = {
        ...item,
        cycleId: command.cycleId,
        status: 'NEW',
        unseenActivityCount: 0,
        needsAttention: true,
        firstDetectedAt: command.at,
        updatedAt: command.at,
        reopenedCount: item.reopenedCount + 1,
        deadline: {
          kind: 'unacknowledged',
          firstAt: command.at + settings.unacknowledgedAfterMs,
          repeatEveryMs: settings.unacknowledgedRepeatMs,
        },
      };
      const previous = { ...item, cycleId: command.cycleId };
      return {
        item: next,
        changed: true,
        transition: transitionFor(
          previous,
          command.kind,
          next.status,
          command.at,
          transitionSequence,
        ),
        effects: [
          {
            id: alertEffectId(item.id, command.cycleId, 'reopen', 0),
            accountId: item.accountId,
            itemId: item.id,
            cycleId: command.cycleId,
            kind: 'reopen',
            stage: 0,
            dueAt: command.at,
            status: 'pending',
          },
        ],
      };
    }
  }
}

export function applyActivityMaintenance(
  activity: QueueActivity,
  command: ActivityMaintenanceCommand,
): QueueActivity {
  switch (command.kind) {
    case 'apply_edit':
      return {
        ...activity,
        ...(command.preview === undefined ? {} : { preview: command.preview }),
        edited: true,
      };
    case 'apply_redaction':
      return { ...activity, preview: 'Message removed', redacted: true };
    case 'enrich_decrypted_content':
      return {
        ...activity,
        preview: command.preview,
        ...(command.messageType === undefined ? {} : { messageType: command.messageType }),
        ...(command.media === undefined ? {} : { media: command.media }),
        contentState: 'clear',
        decryptionFailureCode: undefined,
      };
    case 'record_decryption_failure':
      return {
        ...activity,
        contentState: 'unavailable',
        decryptionFailureCode: command.reasonCode,
      };
  }
}

export function evaluateDeadlines(item: QueueItem, now: number): readonly AlertEffect[] {
  assertTimestamp(now, 'Evaluation time');
  const deadline = item.deadline;
  if (item.status === 'COMPLETED' || !deadline || now < deadline.firstAt) return [];
  // Only the stage that is currently due is materialized. Stages that elapsed while the page was
  // closed, backgrounded, or busy cannot be delivered retroactively — external delivery is
  // best-effort and runs only while the page runs (ADR-0009) — and materializing them would create
  // an unbounded alert backlog: one effect per repeat interval for the whole elapsed period, each
  // becoming a delivery per transport. A week away produced over two thousand for a single item.
  const latestStage = Math.floor((now - deadline.firstAt) / deadline.repeatEveryMs);
  return [
    {
      id: alertEffectId(item.id, item.cycleId, deadline.kind, latestStage),
      accountId: item.accountId,
      itemId: item.id,
      cycleId: item.cycleId,
      kind: deadline.kind,
      stage: latestStage,
      dueAt: deadline.firstAt + latestStage * deadline.repeatEveryMs,
      status: 'pending' as const,
    },
  ];
}

export function compareQueueItems(left: QueueItem, right: QueueItem): number {
  const leftBucket = left.status === 'COMPLETED' ? 1 : 0;
  const rightBucket = right.status === 'COMPLETED' ? 1 : 0;
  if (leftBucket !== rightBucket) return leftBucket - rightBucket;
  if (left.needsAttention !== right.needsAttention) return left.needsAttention ? -1 : 1;
  if (left.lastActivityAt !== right.lastActivityAt)
    return right.lastActivityAt - left.lastActivityAt;
  return left.id.localeCompare(right.id);
}

export interface ThreadMergeResult {
  readonly item: QueueItem;
  readonly activities: readonly QueueActivity[];
  readonly transitions: readonly WorkflowTransition[];
  readonly effects: readonly AlertEffect[];
  readonly removedItemId: string;
}

export function mergeThreadItems(input: {
  readonly left: QueueItem;
  readonly right: QueueItem;
  readonly activities: readonly QueueActivity[];
  readonly transitions: readonly WorkflowTransition[];
  readonly effects: readonly AlertEffect[];
  readonly threadConversationKey: string;
  readonly rootEventId: string;
  readonly at: number;
  readonly transitionSequence: number;
}): ThreadMergeResult {
  if (input.left.accountId !== input.right.accountId || input.left.roomId !== input.right.roomId) {
    throw new QueueDomainError('invalid_input', 'Thread merge items must share account and room.');
  }
  const ordered = [input.left, input.right].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const survivor = ordered[0] as QueueItem;
  const removed = ordered[1] as QueueItem;
  const uniqueActivities = [
    ...new Map(input.activities.map((activity) => [activity.id, activity])).values(),
  ]
    .sort(
      (left, right) =>
        left.detectedAt - right.detectedAt ||
        left.localSequence - right.localSequence ||
        left.eventId.localeCompare(right.eventId),
    )
    .map((activity) => ({ ...activity, itemId: survivor.id }));
  const preferredState =
    input.left.updatedAt > input.right.updatedAt
      ? input.left
      : input.right.updatedAt > input.left.updatedAt
        ? input.right
        : input.left.id.localeCompare(input.right.id) <= 0
          ? input.left
          : input.right;
  const item: QueueItem = {
    ...preferredState,
    id: survivor.id,
    conversationKey: input.threadConversationKey,
    rootEventId: input.rootEventId,
    activityCount: uniqueActivities.length,
    unseenActivityCount: Math.min(
      uniqueActivities.length,
      input.left.unseenActivityCount + input.right.unseenActivityCount,
    ),
    needsAttention: input.left.needsAttention || input.right.needsAttention,
    createdAt: Math.min(input.left.createdAt, input.right.createdAt),
    firstDetectedAt: Math.min(input.left.firstDetectedAt, input.right.firstDetectedAt),
    lastActivityAt: Math.max(input.left.lastActivityAt, input.right.lastActivityAt),
    updatedAt: input.at,
  };
  const effects = input.effects.map((effect) =>
    effect.itemId === removed.id ? { ...effect, status: 'cancelled' as const } : effect,
  );
  const transitions = [
    ...new Map(input.transitions.map((transition) => [transition.id, transition])).values(),
    {
      ...transitionFor(
        item,
        'thread_merge',
        item.status,
        input.at,
        input.transitionSequence,
        removed.id,
      ),
    },
  ];
  return { item, activities: uniqueActivities, transitions, effects, removedItemId: removed.id };
}
