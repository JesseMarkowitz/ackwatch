import { z } from 'zod';

import {
  acceptAdditionalActivity,
  applyActivityMaintenance,
  applyQueueCommand,
  compareQueueItems,
  conversationKeyFor,
  createQueueItem,
  defaultQueueSettings,
  evaluateDeadlines,
  mergeThreadItems,
  type ActivityMaintenanceCommand,
  type AlertEffect,
  type QueueActivity,
  type QueueCommand,
  type QueueItem,
  type QueueSettings,
  type WorkflowTransition,
} from '../../domain/queue';
import {
  defaultSessionContinuityWindowMs,
  WorkflowDatabase,
  type AlertAttemptRecord,
  type AlertDeliveryRecord,
  type AlertTransportKind,
  type AccountSettingsRecord,
  type ConversationRecord,
  type QuarantinedRecord,
  type PersistedIngestionIssueRecord,
  type WorkSessionRecord,
} from './workflow-database';

const deadlineSchema = z.object({
  firstAt: z.number().int().nonnegative(),
  repeatEveryMs: z.number().int().positive(),
  kind: z.enum(['unacknowledged', 'acknowledged']),
});
const queueItemSchema: z.ZodType<QueueItem> = z.object({
  latestActivity: z
    .object({
      eventId: z.string().min(1),
      sender: z.string().min(1),
      preview: z.string(),
      roomName: z.string().optional(),
    })
    .optional(),
  id: z.string().min(1),
  accountId: z.string().min(1),
  conversationKey: z.string().min(1),
  roomId: z.string().startsWith('!'),
  rootEventId: z.string().startsWith('$').optional(),
  cycleId: z.string().min(1),
  status: z.enum(['NEW', 'UNACKNOWLEDGED', 'ACKNOWLEDGED', 'COMPLETED']),
  activityCount: z.number().int().positive(),
  unseenActivityCount: z.number().int().nonnegative(),
  needsAttention: z.boolean(),
  firstDetectedAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  firstViewedAt: z.number().int().nonnegative().optional(),
  acknowledgedAt: z.number().int().nonnegative().optional(),
  completedAt: z.number().int().nonnegative().optional(),
  reopenedCount: z.number().int().nonnegative(),
  deadline: deadlineSchema.optional(),
});
const activitySchema: z.ZodType<QueueActivity> = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  eventId: z.string().startsWith('$'),
  itemId: z.string().min(1),
  roomId: z.string().startsWith('!'),
  sender: z.string().startsWith('@'),
  eventType: z.string().min(1),
  messageType: z.string().min(1),
  preview: z.string().max(160),
  detectedAt: z.number().int().nonnegative(),
  localSequence: z.number().int().nonnegative(),
  provenance: z.string().min(1),
  contentState: z.enum(['clear', 'encrypted_placeholder', 'unavailable']),
  decryptionFailureCode: z.string().min(1).optional(),
  media: z
    .object({
      name: z.string().max(160),
      mimeType: z.string().max(160).optional(),
      size: z.number().int().nonnegative().optional(),
      width: z.number().int().nonnegative().optional(),
      height: z.number().int().nonnegative().optional(),
    })
    .optional(),
  edited: z.boolean(),
  redacted: z.boolean(),
  relationKind: z.enum(['independent', 'thread', 'reply']),
  relationEventId: z.string().startsWith('$').optional(),
  roomName: z.string().optional(),
});
const transitionSchema: z.ZodType<WorkflowTransition> = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  itemId: z.string().min(1),
  cycleId: z.string().min(1),
  command: z.enum([
    'mark_viewed',
    'acknowledge',
    'review_new_activity',
    'complete',
    'manual_reopen',
    'accept_activity',
    'thread_merge',
  ]),
  fromStatus: z.enum(['NEW', 'UNACKNOWLEDGED', 'ACKNOWLEDGED', 'COMPLETED']).optional(),
  toStatus: z.enum(['NEW', 'UNACKNOWLEDGED', 'ACKNOWLEDGED', 'COMPLETED']),
  at: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  sourceItemId: z.string().optional(),
});
const effectSchema: z.ZodType<AlertEffect> = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  itemId: z.string().min(1),
  cycleId: z.string().min(1),
  kind: z.enum(['initial', 'reopen', 'unacknowledged', 'acknowledged']),
  stage: z.number().int().nonnegative(),
  dueAt: z.number().int().nonnegative(),
  status: z.enum(['pending', 'delivered', 'cancelled']),
});
const deliverySchema: z.ZodType<AlertDeliveryRecord> = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  effectId: z.string().min(1),
  itemId: z.string().min(1),
  transport: z.enum(['audio', 'browser_notification', 'webhook']),
  status: z.enum(['pending', 'delivering', 'delivered', 'exhausted']),
  attemptCount: z.number().int().nonnegative(),
  nextAttemptAt: z.number().int().nonnegative(),
  leaseUntil: z.number().int().nonnegative().optional(),
  deliveredAt: z.number().int().nonnegative().optional(),
  lastErrorCode: z.string().min(1).optional(),
  updatedAt: z.number().int().nonnegative(),
});
const attemptSchema: z.ZodType<AlertAttemptRecord> = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  effectId: z.string().min(1),
  deliveryId: z.string().min(1),
  transport: z.enum(['audio', 'browser_notification', 'webhook']),
  attempt: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  outcome: z.enum(['started', 'delivered', 'retry_scheduled', 'exhausted']),
  responseStatus: z.number().int().min(100).max(599).optional(),
  errorCode: z.string().min(1).optional(),
});
const settingsSchema: z.ZodType<AccountSettingsRecord> = z.object({
  accountId: z.string().min(1),
  schemaVersion: z.literal(3),
  unacknowledgedAfterMs: z.number().int().positive(),
  unacknowledgedRepeatMs: z.number().int().positive(),
  acknowledgedAfterMs: z.number().int().positive(),
  acknowledgedRepeatMs: z.number().int().positive(),
  diagnosticsRetentionDays: z.number().int().min(1).max(3650),
  sessionContinuityWindowMs: z
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60_000),
  previewPrivacy: z.enum(['short', 'generic']),
  audioEnabled: z.boolean(),
  audioVolume: z.number().min(0).max(1),
  browserNotificationsEnabled: z.boolean(),
  webhookEnabled: z.boolean(),
  webhookPreset: z.enum(['generic', 'ntfy']),
  webhookEndpoint: z.string().max(2048),
  webhookTopic: z.string().max(256),
  webhookTimeoutMs: z.number().int().min(1000).max(60_000),
  webhookMaxAttempts: z.number().int().min(1).max(20),
  updatedAt: z.number().int().nonnegative(),
});
/** The released Phase 4 settings export shape, kept so those files still import. */
const phaseFourSettingsSchema = z.object({
  accountId: z.string().min(1),
  schemaVersion: z.literal(2),
  unacknowledgedAfterMs: z.number().int().positive(),
  unacknowledgedRepeatMs: z.number().int().positive(),
  acknowledgedAfterMs: z.number().int().positive(),
  acknowledgedRepeatMs: z.number().int().positive(),
  diagnosticsRetentionDays: z.number().int().min(1).max(3650),
  previewPrivacy: z.enum(['short', 'generic']),
  audioEnabled: z.boolean(),
  audioVolume: z.number().min(0).max(1),
  browserNotificationsEnabled: z.boolean(),
  webhookEnabled: z.boolean(),
  webhookPreset: z.enum(['generic', 'ntfy']),
  webhookEndpoint: z.string().max(2048),
  webhookTopic: z.string().max(256),
  webhookTimeoutMs: z.number().int().min(1000).max(60_000),
  webhookMaxAttempts: z.number().int().min(1).max(20),
  updatedAt: z.number().int().nonnegative(),
});
const phaseThreeSettingsSchema = z.object({
  accountId: z.string().min(1),
  schemaVersion: z.literal(1),
  unacknowledgedAfterMs: z.number().int().positive(),
  unacknowledgedRepeatMs: z.number().int().positive(),
  acknowledgedAfterMs: z.number().int().positive(),
  acknowledgedRepeatMs: z.number().int().positive(),
  diagnosticsRetentionDays: z.number().int().min(1).max(3650),
  previewPrivacy: z.enum(['short', 'generic']),
  audioEnabled: z.boolean(),
  browserNotificationsEnabled: z.boolean(),
  webhookEnabled: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
});

export interface AcceptedActivityInput {
  readonly accountId: string;
  readonly eventId: string;
  readonly roomId: string;
  readonly sender: string;
  readonly eventType: string;
  readonly messageType: string;
  readonly preview: string;
  readonly detectedAt: number;
  readonly localSequence: number;
  readonly provenance: string;
  readonly contentState?: QueueActivity['contentState'];
  readonly decryptionFailureCode?: string;
  readonly media?: QueueActivity['media'];
  readonly relationKind?: QueueActivity['relationKind'];
  readonly relationEventId?: string;
  readonly roomName?: string;
}

export type PersistenceFaultPoint =
  'after_activity' | 'after_item' | 'after_conversation' | 'after_transition' | 'after_effect';

export interface UiProjection {
  readonly items: readonly QueueItem[];
  /** Only deliveries that have given up: the sole delivery state the queue view renders. */
  readonly exhaustedDeliveries: readonly AlertDeliveryRecord[];
  readonly quarantineCount: number;
}

export interface WorkflowProjection {
  readonly items: readonly QueueItem[];
  readonly activities: readonly QueueActivity[];
  readonly transitions: readonly WorkflowTransition[];
  readonly effects: readonly AlertEffect[];
  readonly deliveries: readonly AlertDeliveryRecord[];
  readonly quarantineCount: number;
}

export type StorageHealth =
  | { readonly state: 'healthy' }
  | { readonly state: 'blocked' | 'closed' | 'corrupt' | 'failed'; readonly detail: string };

export interface AcceptResult {
  readonly status: 'accepted' | 'duplicate';
  readonly itemId?: string;
}

function recordId(accountId: string, value: string): string {
  return `${accountId}|${value}`;
}

function queueSettings(settings: AccountSettingsRecord): QueueSettings {
  return {
    unacknowledgedAfterMs: settings.unacknowledgedAfterMs,
    unacknowledgedRepeatMs: settings.unacknowledgedRepeatMs,
    acknowledgedAfterMs: settings.acknowledgedAfterMs,
    acknowledgedRepeatMs: settings.acknowledgedRepeatMs,
  };
}

export function defaultAccountSettings(accountId: string, now: number): AccountSettingsRecord {
  return {
    accountId,
    schemaVersion: 3,
    ...defaultQueueSettings,
    diagnosticsRetentionDays: 30,
    sessionContinuityWindowMs: defaultSessionContinuityWindowMs,
    previewPrivacy: 'short',
    audioEnabled: false,
    audioVolume: 0.8,
    browserNotificationsEnabled: false,
    webhookEnabled: false,
    webhookPreset: 'generic',
    webhookEndpoint: '',
    webhookTopic: '',
    webhookTimeoutMs: 10_000,
    webhookMaxAttempts: 5,
    updatedAt: now,
  };
}

export class WorkflowRepository {
  private readonly database: WorkflowDatabase;
  private intentionallyClosing = false;
  /**
   * Parsed queue items, reused when the stored row has not changed.
   *
   * `uiProjection` runs after every ingested event and every command, and it used to re-validate
   * every row through zod on each call. That cost grows with the queue rather than with what
   * changed, and it also handed React a brand-new object for every item every time, so no amount
   * of memoization in the UI could ever skip an unchanged card.
   *
   * Reuse is keyed on the serialized row rather than on `updatedAt`. Every mutation in
   * `domain/queue.ts` does bump `updatedAt` today, but nothing enforces that, and an item whose
   * displayed state silently lags its stored state is a worse failure for an attention monitor
   * than a slow one. Comparing the row itself means a missed reuse costs a parse and nothing else:
   * the cache can never serve content that differs from what is stored.
   */
  private itemCache = new Map<
    string,
    { readonly serialized: string; readonly parsed: QueueItem }
  >();
  private itemCacheAccountId: string | undefined;

  public constructor(
    databaseName = 'ackwatch-workflow',
    private readonly idFactory: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
    private readonly onStorageHealth: (health: StorageHealth) => void = () => undefined,
  ) {
    this.database = new WorkflowDatabase(databaseName);
    this.database.on('blocked', () => {
      this.onStorageHealth({
        state: 'blocked',
        detail: 'Workflow storage upgrade is blocked by another open AckWatch page.',
      });
    });
    this.database.on('versionchange', () => {
      this.onStorageHealth({
        state: 'closed',
        detail: 'Workflow storage closed for a schema upgrade in another page.',
      });
      this.database.close();
    });
    this.database.on('close', () => {
      if (!this.intentionallyClosing) {
        this.onStorageHealth({
          state: 'closed',
          detail: 'Workflow storage closed unexpectedly. Durable acceptance is unavailable.',
        });
      }
    });
  }

  public async open(): Promise<void> {
    try {
      await this.database.open();
      this.onStorageHealth({ state: 'healthy' });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'Workflow storage failed to open.';
      this.onStorageHealth({ state: 'failed', detail });
      throw error;
    }
  }

  public async acceptActivity(
    input: AcceptedActivityInput,
    faultAfter?: PersistenceFaultPoint,
  ): Promise<AcceptResult> {
    try {
      return await this.database.transaction(
        'rw',
        [
          this.database.activities,
          this.database.queueItems,
          this.database.conversationKeys,
          this.database.workflowTransitions,
          this.database.alertEffects,
          this.database.settings,
        ],
        async () => {
          const activityId = recordId(input.accountId, input.eventId);
          if (await this.database.activities.get(activityId)) return { status: 'duplicate' };

          let settings = await this.database.settings.get(input.accountId);
          if (!settings) {
            settings = defaultAccountSettings(input.accountId, input.detectedAt);
            await this.database.settings.add(settings);
          }
          const eventKey = conversationKeyFor(input.roomId, input.eventId);
          const rootEventId = input.relationKind === 'thread' ? input.relationEventId : undefined;
          const threadKey = rootEventId
            ? conversationKeyFor(input.roomId, input.eventId, rootEventId)
            : conversationKeyFor(input.roomId, input.eventId, input.eventId);
          const eventConversation = await this.database.conversationKeys.get(
            recordId(input.accountId, eventKey),
          );
          const threadConversation = await this.database.conversationKeys.get(
            recordId(input.accountId, threadKey),
          );
          let itemRecord: QueueItem | undefined;
          let activeKey = eventKey;

          if (rootEventId) {
            const rootKey = conversationKeyFor(input.roomId, rootEventId);
            const rootConversation = await this.database.conversationKeys.get(
              recordId(input.accountId, rootKey),
            );
            activeKey = threadKey;
            if (
              rootConversation &&
              threadConversation &&
              rootConversation.itemId !== threadConversation.itemId
            ) {
              itemRecord = await this.mergeItems(
                rootConversation,
                threadConversation,
                threadKey,
                rootEventId,
                input.detectedAt,
              );
            } else {
              const selected = rootConversation ?? threadConversation;
              if (selected) {
                itemRecord = await this.database.queueItems.get(selected.itemId);
                if (itemRecord && itemRecord.conversationKey !== threadKey) {
                  itemRecord = { ...itemRecord, conversationKey: threadKey, rootEventId };
                  await this.database.queueItems.put(itemRecord);
                  await this.database.conversationKeys.delete(selected.id);
                  await this.database.conversationKeys.put({
                    id: recordId(input.accountId, threadKey),
                    accountId: input.accountId,
                    key: threadKey,
                    itemId: itemRecord.id,
                  });
                }
              }
            }
          } else if (threadConversation) {
            activeKey = threadKey;
            itemRecord = await this.database.queueItems.get(threadConversation.itemId);
          } else if (eventConversation) {
            itemRecord = await this.database.queueItems.get(eventConversation.itemId);
          }

          const itemId = itemRecord?.id ?? this.idFactory();
          const activity: QueueActivity = activitySchema.parse({
            id: activityId,
            accountId: input.accountId,
            eventId: input.eventId,
            itemId,
            roomId: input.roomId,
            sender: input.sender,
            eventType: input.eventType,
            messageType: input.messageType,
            preview: settings.previewPrivacy === 'generic' ? 'New Matrix activity' : input.preview,
            detectedAt: input.detectedAt,
            localSequence: input.localSequence,
            provenance: input.provenance,
            contentState: input.contentState ?? 'clear',
            ...(input.decryptionFailureCode === undefined
              ? {}
              : { decryptionFailureCode: input.decryptionFailureCode }),
            ...(input.media === undefined ? {} : { media: input.media }),
            edited: false,
            redacted: false,
            relationKind: input.relationKind ?? 'independent',
            ...(input.relationEventId === undefined
              ? {}
              : { relationEventId: input.relationEventId }),
            ...(input.roomName === undefined ? {} : { roomName: input.roomName }),
          });
          await this.database.activities.add(activity);
          this.inject(faultAfter, 'after_activity');

          const transitionSequence = itemRecord
            ? await this.database.workflowTransitions.where('itemId').equals(itemRecord.id).count()
            : 0;
          const mutation = itemRecord
            ? acceptAdditionalActivity(
                itemRecord,
                input.detectedAt,
                this.idFactory(),
                queueSettings(settings),
                transitionSequence,
              )
            : createQueueItem({
                id: itemId,
                accountId: input.accountId,
                conversationKey: activeKey,
                roomId: input.roomId,
                eventId: input.eventId,
                cycleId: this.idFactory(),
                detectedAt: input.detectedAt,
                settings: queueSettings(settings),
                ...(rootEventId === undefined ? {} : { rootEventId }),
              });
          // The card renders the newest activity, so the item carries a copy of it. Gap recovery can
          // deliver an older event after a newer one, so only a genuinely newer activity replaces it.
          const previousLatest = itemRecord?.latestActivity;
          const isNewer =
            !previousLatest ||
            activity.detectedAt > (itemRecord?.lastActivityAt ?? 0) ||
            activity.detectedAt === (itemRecord?.lastActivityAt ?? 0);
          const latestActivity = isNewer
            ? {
                eventId: activity.eventId,
                sender: activity.sender,
                preview: activity.preview,
                ...(activity.roomName === undefined ? {} : { roomName: activity.roomName }),
              }
            : previousLatest;
          await this.database.queueItems.put(
            queueItemSchema.parse({ ...mutation.item, latestActivity }),
          );
          this.inject(faultAfter, 'after_item');

          if (!itemRecord) {
            const conversation: ConversationRecord = {
              id: recordId(input.accountId, activeKey),
              accountId: input.accountId,
              key: activeKey,
              itemId,
            };
            await this.database.conversationKeys.add(conversation);
          }
          this.inject(faultAfter, 'after_conversation');

          if (mutation.transition) {
            await this.database.workflowTransitions.add(
              transitionSchema.parse(mutation.transition),
            );
          }
          this.inject(faultAfter, 'after_transition');
          if (mutation.effects.length > 0) {
            await this.database.alertEffects.bulkAdd(
              mutation.effects.map((effect) => effectSchema.parse(effect)),
            );
          }
          this.inject(faultAfter, 'after_effect');
          return { status: 'accepted', itemId };
        },
      );
    } catch (error: unknown) {
      this.onStorageHealth({
        state: 'failed',
        detail: error instanceof Error ? error.message : 'Workflow transaction failed.',
      });
      throw error;
    }
  }

  public async applyCommand(
    accountId: string,
    itemId: string,
    command: QueueCommand,
  ): Promise<void> {
    await this.database.transaction(
      'rw',
      [
        this.database.queueItems,
        this.database.workflowTransitions,
        this.database.alertEffects,
        this.database.alertDeliveries,
        this.database.settings,
      ],
      async () => {
        const item = queueItemSchema.parse(await this.database.queueItems.get(itemId));
        if (item.accountId !== accountId) throw new Error('Queue item belongs to another account.');
        const settings =
          (await this.database.settings.get(accountId)) ??
          defaultAccountSettings(accountId, command.at);
        const sequence = await this.database.workflowTransitions
          .where('itemId')
          .equals(itemId)
          .count();
        const mutation = applyQueueCommand(item, command, queueSettings(settings), sequence);
        if (!mutation.changed) return;
        await this.database.queueItems.put(queueItemSchema.parse(mutation.item));
        if (command.kind === 'acknowledge' || command.kind === 'complete') {
          const cancelledEffects = await this.database.alertEffects
            .where('itemId')
            .equals(itemId)
            .filter(
              (effect) =>
                effect.cycleId === item.cycleId &&
                effect.status === 'pending' &&
                (command.kind === 'complete' || effect.kind === 'unacknowledged'),
            )
            .primaryKeys();
          if (cancelledEffects.length > 0) {
            await this.database.alertEffects
              .where('id')
              .anyOf(cancelledEffects)
              .modify({ status: 'cancelled' });
            await this.database.alertDeliveries
              .where('effectId')
              .anyOf(cancelledEffects)
              .filter(({ status }) => status === 'pending' || status === 'delivering')
              .modify({ status: 'exhausted', lastErrorCode: 'EFFECT_CANCELLED' });
          }
          if (command.kind === 'complete') {
            await this.database.alertDeliveries
              .where('itemId')
              .equals(itemId)
              .filter(({ status }) => status === 'pending' || status === 'delivering')
              .modify({ status: 'exhausted', lastErrorCode: 'WORKFLOW_COMPLETED' });
          }
        }
        if (mutation.transition) {
          await this.database.workflowTransitions.add(transitionSchema.parse(mutation.transition));
        }
        if (mutation.effects.length > 0) {
          await this.database.alertEffects.bulkAdd(
            mutation.effects.map((effect) => effectSchema.parse(effect)),
          );
        }
      },
    );
  }

  public async evaluateDeadlines(accountId: string, now: number): Promise<number> {
    return await this.database.transaction(
      'rw',
      [this.database.queueItems, this.database.alertEffects],
      async () => {
        const items = await this.database.queueItems.where('accountId').equals(accountId).toArray();
        const candidates: AlertEffect[] = [];
        for (const raw of items) {
          candidates.push(...evaluateDeadlines(queueItemSchema.parse(raw), now));
        }
        if (candidates.length === 0) return 0;
        // One batched existence check rather than a round trip per item: at a thousand items the
        // sequential form dominated the scheduler pass, which runs every fifteen seconds.
        const existing = await this.database.alertEffects.bulkGet(candidates.map(({ id }) => id));
        const missing = candidates
          .filter((_, index) => existing[index] === undefined)
          .map((effect) => effectSchema.parse(effect));
        if (missing.length > 0) await this.database.alertEffects.bulkAdd(missing);
        return missing.length;
      },
    );
  }

  public async prepareDueAlertDeliveries(
    accountId: string,
    now: number,
    transports: readonly AlertTransportKind[],
  ): Promise<readonly AlertDeliveryRecord[]> {
    await this.evaluateDeadlines(accountId, now);
    return await this.database.transaction(
      'rw',
      [this.database.alertEffects, this.database.alertDeliveries],
      async () => {
        const effects = await this.database.alertEffects
          .where('[accountId+status]')
          .equals([accountId, 'pending'])
          .filter(({ dueAt }) => dueAt <= now)
          .toArray();
        const ready: AlertDeliveryRecord[] = [];
        const parsedEffects = effects.map((value) => effectSchema.parse(value));
        // Batched so one scheduler pass costs a couple of round trips rather than one per
        // effect-transport pair.
        const deliveryIds = parsedEffects.flatMap((effect) =>
          transports.map((transport) => `${effect.id}|${transport}`),
        );
        const existingDeliveries = new Map(
          (await this.database.alertDeliveries.bulkGet(deliveryIds))
            .filter((value): value is AlertDeliveryRecord => value !== undefined)
            .map((value) => [value.id, value]),
        );
        for (const effect of parsedEffects) {
          if (transports.length === 0) {
            await this.database.alertEffects.update(effect.id, { status: 'delivered' });
            continue;
          }
          for (const transport of transports) {
            const id = `${effect.id}|${transport}`;
            let delivery = existingDeliveries.get(id);
            if (!delivery) {
              delivery = deliverySchema.parse({
                id,
                accountId,
                effectId: effect.id,
                itemId: effect.itemId,
                transport,
                status: 'pending',
                attemptCount: 0,
                nextAttemptAt: effect.dueAt,
                updatedAt: now,
              });
              await this.database.alertDeliveries.add(delivery);
            }
            const parsed = deliverySchema.parse(delivery);
            if (
              (parsed.status === 'pending' && parsed.nextAttemptAt <= now) ||
              (parsed.status === 'delivering' && (parsed.leaseUntil ?? 0) <= now)
            ) {
              ready.push(parsed);
            }
          }
        }
        return ready;
      },
    );
  }

  public async claimAlertDelivery(
    accountId: string,
    deliveryId: string,
    now: number,
    leaseMs = 30_000,
  ): Promise<AlertDeliveryRecord | undefined> {
    return await this.database.transaction(
      'rw',
      [this.database.alertDeliveries, this.database.alertAttempts],
      async () => {
        const existing = this.parseOwnedDelivery(
          accountId,
          await this.database.alertDeliveries.get(deliveryId),
        );
        if (!existing) return undefined;
        const claimable =
          (existing.status === 'pending' && existing.nextAttemptAt <= now) ||
          (existing.status === 'delivering' && (existing.leaseUntil ?? 0) <= now);
        if (!claimable) return undefined;
        const claimed = deliverySchema.parse({
          ...existing,
          status: 'delivering',
          attemptCount: existing.attemptCount + 1,
          leaseUntil: now + leaseMs,
          updatedAt: now,
        });
        await this.database.alertDeliveries.put(claimed);
        await this.database.alertAttempts.add(
          attemptSchema.parse({
            id: `${deliveryId}|${claimed.attemptCount}`,
            accountId,
            effectId: claimed.effectId,
            deliveryId,
            transport: claimed.transport,
            attempt: claimed.attemptCount,
            startedAt: now,
            outcome: 'started',
          }),
        );
        return claimed;
      },
    );
  }

  public async settleAlertDelivery(
    accountId: string,
    deliveryId: string,
    result:
      | { readonly status: 'delivered'; readonly at: number; readonly responseStatus?: number }
      | {
          readonly status: 'failed';
          readonly at: number;
          readonly errorCode: string;
          readonly retryable: boolean;
          readonly maxAttempts: number;
          readonly responseStatus?: number;
        },
  ): Promise<AlertDeliveryRecord> {
    return await this.database.transaction(
      'rw',
      [this.database.alertEffects, this.database.alertDeliveries, this.database.alertAttempts],
      async () => {
        const existing = this.parseOwnedDelivery(
          accountId,
          await this.database.alertDeliveries.get(deliveryId),
        );
        if (!existing || existing.status !== 'delivering') {
          throw new Error('Alert delivery is not actively claimed.');
        }
        const willRetry =
          result.status === 'failed' &&
          result.retryable &&
          existing.attemptCount < result.maxAttempts;
        const next = deliverySchema.parse(
          result.status === 'delivered'
            ? {
                ...existing,
                status: 'delivered',
                deliveredAt: result.at,
                leaseUntil: undefined,
                lastErrorCode: undefined,
                updatedAt: result.at,
              }
            : {
                ...existing,
                status: willRetry ? 'pending' : 'exhausted',
                nextAttemptAt: willRetry
                  ? result.at + Math.min(60_000, 1_000 * 2 ** (existing.attemptCount - 1))
                  : existing.nextAttemptAt,
                leaseUntil: undefined,
                lastErrorCode: result.errorCode,
                updatedAt: result.at,
              },
        );
        await this.database.alertDeliveries.put(next);
        const attemptId = `${deliveryId}|${existing.attemptCount}`;
        await this.database.alertAttempts.update(attemptId, {
          finishedAt: result.at,
          outcome:
            result.status === 'delivered'
              ? 'delivered'
              : willRetry
                ? 'retry_scheduled'
                : 'exhausted',
          ...(result.responseStatus === undefined ? {} : { responseStatus: result.responseStatus }),
          ...(result.status === 'failed' ? { errorCode: result.errorCode } : {}),
        });
        const siblings = await this.database.alertDeliveries
          .where('effectId')
          .equals(existing.effectId)
          .toArray();
        if (
          siblings.every(({ id, status }) =>
            id === next.id
              ? next.status === 'delivered' || next.status === 'exhausted'
              : status === 'delivered' || status === 'exhausted',
          )
        ) {
          await this.database.alertEffects.update(existing.effectId, { status: 'delivered' });
        }
        return next;
      },
    );
  }

  public async retryAlertDelivery(
    accountId: string,
    deliveryId: string,
    now: number,
  ): Promise<void> {
    const existing = this.parseOwnedDelivery(
      accountId,
      await this.database.alertDeliveries.get(deliveryId),
    );
    if (!existing || existing.status !== 'exhausted') {
      throw new Error('Only an exhausted alert delivery can be retried manually.');
    }
    await this.database.transaction(
      'rw',
      [this.database.alertEffects, this.database.alertDeliveries],
      async () => {
        await this.database.alertDeliveries.update(deliveryId, {
          status: 'pending',
          nextAttemptAt: now,
          lastErrorCode: undefined,
          updatedAt: now,
        });
        await this.database.alertEffects.update(existing.effectId, { status: 'pending' });
      },
    );
  }

  public async applyMaintenance(
    accountId: string,
    targetEventId: string,
    command: ActivityMaintenanceCommand,
  ): Promise<boolean> {
    const id = recordId(accountId, targetEventId);
    return await this.database.transaction(
      'rw',
      [this.database.activities, this.database.queueItems],
      async () => {
        const existing = await this.database.activities.get(id);
        if (!existing) return false;
        const updated = activitySchema.parse(
          applyActivityMaintenance(activitySchema.parse(existing), command),
        );
        await this.database.activities.put(updated);
        // An edit, redaction, or late decryption of the newest activity changes what the card
        // shows, so the denormalized copy has to move with it.
        const item = await this.database.queueItems.get(updated.itemId);
        if (item?.latestActivity?.eventId === updated.eventId) {
          await this.database.queueItems.put(
            queueItemSchema.parse({
              ...item,
              latestActivity: {
                ...item.latestActivity,
                sender: updated.sender,
                preview: updated.preview,
                ...(updated.roomName === undefined ? {} : { roomName: updated.roomName }),
              },
            }),
          );
        }
        return true;
      },
    );
  }

  public async recordIngestionIssue(
    issue: Omit<PersistedIngestionIssueRecord, 'id' | 'status'>,
  ): Promise<void> {
    const id = recordId(
      issue.accountId,
      `issue:${issue.eventId ?? issue.roomId ?? 'unknown'}:${issue.code}:${issue.detectedAt}`,
    );
    await this.database.ingestionIssues.put({ ...issue, id, status: 'open' });
  }

  /** The work session currently open for the account, if any. */
  public async activeWorkSession(accountId: string): Promise<WorkSessionRecord | undefined> {
    const open = await this.database.workSessions
      .where('accountId')
      .equals(accountId)
      .filter(({ endedAt }) => endedAt === undefined)
      .toArray();
    // Defensive: only one session may be open. If a crash ever left more, the newest wins and the
    // older ones are closed rather than left to accumulate.
    const sorted = [...open].sort((left, right) => right.startedAt - left.startedAt);
    const [current, ...stale] = sorted;
    for (const session of stale) {
      await this.database.workSessions.update(session.id, {
        endedAt: session.startedAt,
        endReason: 'stale_auto_new',
      });
    }
    return current;
  }

  public async startWorkSession(accountId: string, startedAt: number): Promise<WorkSessionRecord> {
    const session: WorkSessionRecord = { id: this.idFactory(), accountId, startedAt };
    await this.database.workSessions.add(session);
    return session;
  }

  /**
   * Ends a work session and returns a redacted summary of it. The summary carries counts and
   * timings only: no previews, room IDs, event IDs, or senders, so an archived session can be kept
   * or shared without carrying Matrix content out of the workflow store.
   */
  public async summarizeWorkSession(
    accountId: string,
    session: WorkSessionRecord,
    endedAt: number,
    endReason: NonNullable<WorkSessionRecord['endReason']>,
  ): Promise<string> {
    const projection = await this.projection(accountId);
    const statusCounts: Record<string, number> = {};
    for (const item of projection.items) {
      statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
    }
    const deliveryCounts: Record<string, number> = {};
    for (const delivery of projection.deliveries) {
      deliveryCounts[delivery.status] = (deliveryCounts[delivery.status] ?? 0) + 1;
    }
    const openIssues = await this.database.ingestionIssues
      .where('[accountId+status]')
      .equals([accountId, 'open'])
      .count();
    return JSON.stringify(
      {
        kind: 'ackwatch-session-summary',
        version: 1,
        session: { startedAt: session.startedAt, endedAt, endReason },
        totals: {
          items: projection.items.length,
          activities: projection.activities.length,
          transitions: projection.transitions.length,
          alertEffects: projection.effects.length,
          alertDeliveries: projection.deliveries.length,
          openIngestionIssues: openIssues,
          quarantined: projection.quarantineCount,
        },
        itemsByStatus: statusCounts,
        deliveriesByStatus: deliveryCounts,
      },
      null,
      2,
    );
  }

  /**
   * Clears the work a session accumulated while preserving account configuration. Settings are the
   * user's setup, not session output: wiping an endpoint or an alert preference on every session
   * end would be hostile.
   */
  public async clearSessionWork(accountId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      [
        this.database.queueItems,
        this.database.activities,
        this.database.conversationKeys,
        this.database.workflowTransitions,
        this.database.alertEffects,
        this.database.alertDeliveries,
        this.database.alertAttempts,
        this.database.ingestionIssues,
        this.database.coverageIssues,
        this.database.quarantine,
      ],
      async () => {
        await Promise.all([
          this.database.queueItems.where('accountId').equals(accountId).delete(),
          this.database.activities.where('accountId').equals(accountId).delete(),
          this.database.conversationKeys.where('accountId').equals(accountId).delete(),
          this.database.workflowTransitions.where('accountId').equals(accountId).delete(),
          this.database.alertEffects.where('accountId').equals(accountId).delete(),
          this.database.alertDeliveries.where('accountId').equals(accountId).delete(),
          this.database.alertAttempts.where('accountId').equals(accountId).delete(),
          this.database.ingestionIssues.where('accountId').equals(accountId).delete(),
          this.database.coverageIssues.where('accountId').equals(accountId).delete(),
          this.database.quarantine.where('accountId').equals(accountId).delete(),
        ]);
      },
    );
  }

  public async closeWorkSession(
    sessionId: string,
    endedAt: number,
    endReason: NonNullable<WorkSessionRecord['endReason']>,
  ): Promise<void> {
    await this.database.workSessions.update(sessionId, { endedAt, endReason });
  }

  public async beginMonitoringSession(
    accountId: string,
    sessionId: string,
    startedAt: number,
  ): Promise<void> {
    await this.database.monitoringSessions.add({ id: sessionId, accountId, startedAt });
  }

  public async endMonitoringSession(
    sessionId: string,
    stoppedAt: number,
    stopReason: string,
  ): Promise<void> {
    await this.database.monitoringSessions.update(sessionId, { stoppedAt, stopReason });
  }

  public async getSettings(accountId: string): Promise<AccountSettingsRecord> {
    const existing = await this.database.settings.get(accountId);
    return existing
      ? settingsSchema.parse(existing)
      : defaultAccountSettings(accountId, this.now());
  }

  public async putSettings(settings: AccountSettingsRecord): Promise<void> {
    await this.database.settings.put(settingsSchema.parse(settings));
  }

  public async exportSettings(accountId: string): Promise<string> {
    const settings = await this.getSettings(accountId);
    return JSON.stringify({ kind: 'ackwatch-settings', version: 3, settings }, null, 2);
  }

  public async importSettings(
    accountId: string,
    serialized: string,
  ): Promise<AccountSettingsRecord> {
    const envelope = z
      .discriminatedUnion('version', [
        z.object({
          kind: z.literal('ackwatch-settings'),
          version: z.literal(1),
          settings: phaseThreeSettingsSchema,
        }),
        z.object({
          kind: z.literal('ackwatch-settings'),
          version: z.literal(2),
          settings: phaseFourSettingsSchema,
        }),
        z.object({
          kind: z.literal('ackwatch-settings'),
          version: z.literal(3),
          settings: settingsSchema,
        }),
      ])
      .parse(JSON.parse(serialized));
    const imported = settingsSchema.parse({
      ...defaultAccountSettings(accountId, this.now()),
      ...envelope.settings,
      accountId,
      schemaVersion: 3,
      webhookEnabled: false,
      updatedAt: this.now(),
    });
    await this.database.settings.put(imported);
    return imported;
  }

  /** Targeted lookups for the dispatcher, which needs one effect and one item per delivery and
   * must not read the whole account to find them. */
  public async alertEffect(accountId: string, effectId: string): Promise<AlertEffect | undefined> {
    const raw = await this.database.alertEffects.get(effectId);
    return raw && raw.accountId === accountId ? effectSchema.parse(raw) : undefined;
  }

  public async queueItem(accountId: string, itemId: string): Promise<QueueItem | undefined> {
    const raw = await this.database.queueItems.get(itemId);
    return raw && raw.accountId === accountId ? queueItemSchema.parse(raw) : undefined;
  }

  /** Activities for one item, fetched by index when its detail is opened. */
  public async itemActivities(
    accountId: string,
    itemId: string,
  ): Promise<readonly QueueActivity[]> {
    const rows = await this.database.activities
      .where('[accountId+itemId]')
      .equals([accountId, itemId])
      .toArray();
    return rows
      .map((row) => activitySchema.parse(row))
      .sort(
        (left, right) =>
          left.detectedAt - right.detectedAt ||
          left.localSequence - right.localSequence ||
          left.eventId.localeCompare(right.eventId),
      );
  }

  /**
   * What the queue view needs. Cards render from the item's denormalized latest activity, so the
   * activity and transition tables — the two that grow without bound — are not read at all.
   */
  public async uiProjection(accountId: string): Promise<UiProjection> {
    const [rawItems, rawDeliveries, quarantineCount] = await Promise.all([
      this.database.queueItems.where('accountId').equals(accountId).toArray(),
      this.database.alertDeliveries
        .where('[accountId+status]')
        .equals([accountId, 'exhausted'])
        .toArray(),
      this.database.quarantine.where('accountId').equals(accountId).count(),
    ]);
    // The cache belongs to one account; a different one starts clean rather than sharing entries.
    if (this.itemCacheAccountId !== accountId) {
      this.itemCache = new Map();
      this.itemCacheAccountId = accountId;
    }
    const items: QueueItem[] = [];
    const seen = new Set<string>();
    for (const raw of rawItems) {
      const key = typeof raw.id === 'string' ? raw.id : undefined;
      const serialized = key === undefined ? undefined : JSON.stringify(raw);
      if (key !== undefined) seen.add(key);
      const cached = key === undefined ? undefined : this.itemCache.get(key);
      if (cached !== undefined && cached.serialized === serialized) {
        items.push(cached.parsed);
        continue;
      }
      const parsed = queueItemSchema.safeParse(raw);
      if (parsed.success) {
        items.push(parsed.data);
        if (key !== undefined && serialized !== undefined) {
          this.itemCache.set(key, { serialized, parsed: parsed.data });
        }
      } else {
        if (key !== undefined) this.itemCache.delete(key);
        await this.quarantineItem(accountId, raw, parsed.error.message);
      }
    }
    // Items deleted from the store — a thread merge absorbing one, a session ending — must not sit
    // in the cache for the life of the page.
    for (const key of this.itemCache.keys()) if (!seen.has(key)) this.itemCache.delete(key);
    return {
      items: items.sort(compareQueueItems),
      exhaustedDeliveries: rawDeliveries.map((value) => deliverySchema.parse(value)),
      quarantineCount,
    };
  }

  public async projection(accountId: string): Promise<WorkflowProjection> {
    const rawItems = await this.database.queueItems.where('accountId').equals(accountId).toArray();
    const items: QueueItem[] = [];
    for (const raw of rawItems) {
      const parsed = queueItemSchema.safeParse(raw);
      if (parsed.success) items.push(parsed.data);
      else await this.quarantineItem(accountId, raw, parsed.error.message);
    }
    const activities = (
      await this.database.activities.where('accountId').equals(accountId).toArray()
    ).map((activity) => activitySchema.parse(activity));
    const transitions = (
      await this.database.workflowTransitions.where('accountId').equals(accountId).toArray()
    ).map((transition) => transitionSchema.parse(transition));
    const effects = (
      await this.database.alertEffects.where('accountId').equals(accountId).toArray()
    ).map((effect) => effectSchema.parse(effect));
    const deliveries = (
      await this.database.alertDeliveries.where('accountId').equals(accountId).toArray()
    ).map((delivery) => deliverySchema.parse(delivery));
    const quarantineCount = await this.database.quarantine
      .where('accountId')
      .equals(accountId)
      .count();
    return {
      items: items.sort(compareQueueItems),
      activities: activities.sort(
        (left, right) =>
          left.detectedAt - right.detectedAt ||
          left.localSequence - right.localSequence ||
          left.eventId.localeCompare(right.eventId),
      ),
      transitions,
      effects,
      deliveries,
      quarantineCount,
    };
  }

  /**
   * A support bundle describing how this installation is behaving. It carries counts, codes and
   * timings only: no previews, room IDs, event IDs, senders, user IDs, tokens or endpoints, so it
   * can be attached to a bug report without leaking who the operator watches or what was said.
   */
  public async diagnosticsReport(accountId: string, now: number): Promise<string> {
    const database = this.database;
    const tally = <T>(rows: readonly T[], key: (row: T) => string): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const row of rows) counts[key(row)] = (counts[key(row)] ?? 0) + 1;
      return counts;
    };
    const [
      items,
      activities,
      transitions,
      effects,
      deliveries,
      attempts,
      issues,
      coverage,
      quarantined,
      sessions,
      settings,
    ] = await Promise.all([
      database.queueItems.where('accountId').equals(accountId).toArray(),
      database.activities.where('accountId').equals(accountId).count(),
      database.workflowTransitions.where('accountId').equals(accountId).count(),
      database.alertEffects.where('accountId').equals(accountId).toArray(),
      database.alertDeliveries.where('accountId').equals(accountId).toArray(),
      database.alertAttempts.where('accountId').equals(accountId).toArray(),
      database.ingestionIssues.where('accountId').equals(accountId).toArray(),
      database.coverageIssues.where('accountId').equals(accountId).toArray(),
      database.quarantine.where('accountId').equals(accountId).count(),
      database.workSessions.where('accountId').equals(accountId).toArray(),
      this.getSettings(accountId),
    ]);
    const openSession = sessions.find(({ endedAt }) => endedAt === undefined);
    return JSON.stringify(
      {
        kind: 'ackwatch-diagnostics',
        version: 1,
        generatedAt: new Date(now).toISOString(),
        schema: { database: database.verno, settings: settings.schemaVersion },
        session: {
          open: openSession !== undefined,
          ageMs: openSession ? now - openSession.startedAt : undefined,
          endedThisInstall: sessions.length - (openSession ? 1 : 0),
          continuityWindowMs: settings.sessionContinuityWindowMs,
        },
        queue: {
          items: items.length,
          itemsByStatus: tally(items, (item) => String(item.status)),
          activities,
          transitions,
          quarantined,
        },
        alerts: {
          effectsByStatus: tally(effects, (effect) => effect.status),
          deliveriesByStatus: tally(deliveries, (delivery) => delivery.status),
          deliveriesByTransport: tally(deliveries, (delivery) => delivery.transport),
          attemptsByOutcome: tally(attempts, (attempt) => attempt.outcome),
          // Error codes are AckWatch's own vocabulary and HTTP statuses, never receiver responses.
          errorCodes: tally(
            deliveries.filter(({ lastErrorCode }) => lastErrorCode !== undefined),
            (delivery) => delivery.lastErrorCode ?? 'unknown',
          ),
        },
        ingestion: { issuesByCode: tally(issues, (issue) => issue.code) },
        coverage: {
          issues: coverage.length,
          issuesByStatus: tally(coverage, (issue) => issue.status),
        },
        configuration: {
          previewPrivacy: settings.previewPrivacy,
          audioEnabled: settings.audioEnabled,
          browserNotificationsEnabled: settings.browserNotificationsEnabled,
          // Whether a webhook is configured, never where it points or what authorizes it.
          webhookEnabled: settings.webhookEnabled,
          webhookPreset: settings.webhookPreset,
          webhookTimeoutMs: settings.webhookTimeoutMs,
          webhookMaxAttempts: settings.webhookMaxAttempts,
          diagnosticsRetentionDays: settings.diagnosticsRetentionDays,
          unacknowledgedAfterMs: settings.unacknowledgedAfterMs,
          acknowledgedAfterMs: settings.acknowledgedAfterMs,
        },
      },
      null,
      2,
    );
  }

  /**
   * Applies the configured diagnostics retention. Only finished diagnostic records age out:
   * unresolved issues and live workflow are never removed by retention.
   */
  public async pruneDiagnostics(accountId: string, now: number): Promise<number> {
    const settings = await this.getSettings(accountId);
    const cutoff = now - settings.diagnosticsRetentionDays * 24 * 60 * 60_000;
    if (cutoff <= 0) return 0;
    return await this.database.transaction(
      'rw',
      [this.database.alertAttempts, this.database.ingestionIssues, this.database.workSessions],
      async () => {
        const attempts = await this.database.alertAttempts
          .where('[accountId+startedAt]')
          .between([accountId, 0], [accountId, cutoff])
          .primaryKeys();
        if (attempts.length > 0) await this.database.alertAttempts.bulkDelete(attempts);
        const issues = await this.database.ingestionIssues
          .where('[accountId+status]')
          .equals([accountId, 'resolved'])
          .filter(({ detectedAt }) => detectedAt < cutoff)
          .primaryKeys();
        if (issues.length > 0) await this.database.ingestionIssues.bulkDelete(issues);
        const staleSessions = await this.database.workSessions
          .where('accountId')
          .equals(accountId)
          .filter(({ endedAt }) => endedAt !== undefined && endedAt < cutoff)
          .primaryKeys();
        if (staleSessions.length > 0) await this.database.workSessions.bulkDelete(staleSessions);
        return attempts.length + issues.length + staleSessions.length;
      },
    );
  }

  public async clearAccount(accountId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      [
        this.database.queueItems,
        this.database.activities,
        this.database.conversationKeys,
        this.database.workflowTransitions,
        this.database.alertEffects,
        this.database.alertDeliveries,
        this.database.alertAttempts,
        this.database.settings,
        this.database.monitoringSessions,
        this.database.ingestionIssues,
        this.database.quarantine,
      ],
      async () => {
        await Promise.all([
          this.database.queueItems.where('accountId').equals(accountId).delete(),
          this.database.activities.where('accountId').equals(accountId).delete(),
          this.database.conversationKeys.where('accountId').equals(accountId).delete(),
          this.database.workflowTransitions.where('accountId').equals(accountId).delete(),
          this.database.alertEffects.where('accountId').equals(accountId).delete(),
          this.database.alertDeliveries.where('accountId').equals(accountId).delete(),
          this.database.alertAttempts.where('accountId').equals(accountId).delete(),
          this.database.settings.delete(accountId),
          this.database.monitoringSessions.where('accountId').equals(accountId).delete(),
          this.database.ingestionIssues.where('accountId').equals(accountId).delete(),
          this.database.quarantine.where('accountId').equals(accountId).delete(),
        ]);
      },
    );
  }

  public close(): void {
    this.intentionallyClosing = true;
    this.itemCache = new Map();
    this.itemCacheAccountId = undefined;
    this.database.close();
  }

  /** Test support for released-schema migration fixtures and fault injection only. */
  public unsafeDatabaseForTests(): WorkflowDatabase {
    return this.database;
  }

  private inject(
    requested: PersistenceFaultPoint | undefined,
    current: PersistenceFaultPoint,
  ): void {
    if (requested === current) throw new Error(`Injected transaction failure at ${current}.`);
  }

  private parseOwnedDelivery(
    accountId: string,
    value: AlertDeliveryRecord | undefined,
  ): AlertDeliveryRecord | undefined {
    if (!value) return undefined;
    const parsed = deliverySchema.parse(value);
    if (parsed.accountId !== accountId)
      throw new Error('Alert delivery belongs to another account.');
    return parsed;
  }

  private async mergeItems(
    leftConversation: ConversationRecord,
    rightConversation: ConversationRecord,
    threadKey: string,
    rootEventId: string,
    at: number,
  ): Promise<QueueItem> {
    const left = queueItemSchema.parse(await this.database.queueItems.get(leftConversation.itemId));
    const right = queueItemSchema.parse(
      await this.database.queueItems.get(rightConversation.itemId),
    );
    const itemIds = [left.id, right.id];
    const activities = (
      await this.database.activities.where('itemId').anyOf(itemIds).toArray()
    ).map((activity) => activitySchema.parse(activity));
    const transitions = (
      await this.database.workflowTransitions.where('itemId').anyOf(itemIds).toArray()
    ).map((transition) => transitionSchema.parse(transition));
    const effects = (await this.database.alertEffects.where('itemId').anyOf(itemIds).toArray()).map(
      (effect) => effectSchema.parse(effect),
    );
    const merged = mergeThreadItems({
      left,
      right,
      activities,
      transitions,
      effects,
      threadConversationKey: threadKey,
      rootEventId,
      at,
      transitionSequence: transitions.length,
    });
    await this.database.queueItems.delete(merged.removedItemId);
    await this.database.queueItems.put(queueItemSchema.parse(merged.item));
    await this.database.activities.bulkPut(
      merged.activities.map((activity) => activitySchema.parse(activity)),
    );
    await this.database.workflowTransitions.bulkPut(
      merged.transitions.map((transition) => transitionSchema.parse(transition)),
    );
    await this.database.alertEffects.bulkPut(
      merged.effects.map((effect) => effectSchema.parse(effect)),
    );
    await this.database.conversationKeys.delete(leftConversation.id);
    await this.database.conversationKeys.delete(rightConversation.id);
    await this.database.conversationKeys.put({
      id: recordId(left.accountId, threadKey),
      accountId: left.accountId,
      key: threadKey,
      itemId: merged.item.id,
    });
    return merged.item;
  }

  private async quarantineItem(accountId: string, raw: QueueItem, reason: string): Promise<void> {
    const sourceKey = typeof raw.id === 'string' ? raw.id : this.idFactory();
    const record: QuarantinedRecord = {
      id: this.idFactory(),
      accountId,
      sourceStore: 'queueItems',
      sourceKey,
      reason: reason.slice(0, 500),
      quarantinedAt: this.now(),
      redactedShape: raw && typeof raw === 'object' ? Object.keys(raw).sort() : [],
    };
    await this.database.transaction(
      'rw',
      [this.database.queueItems, this.database.quarantine],
      async () => {
        await this.database.quarantine.add(record);
        await this.database.queueItems.delete(sourceKey);
      },
    );
    this.onStorageHealth({
      state: 'corrupt',
      detail: 'A corrupt queue record was quarantined instead of being loaded.',
    });
  }
}
