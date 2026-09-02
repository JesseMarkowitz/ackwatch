import Dexie, { type EntityTable } from 'dexie';

import type { AlertEffect, QueueActivity, QueueItem, WorkflowTransition } from '../../domain/queue';

export interface PersistedCoverageIssue {
  readonly id: string;
  readonly accountId: string;
  readonly kind: 'gap_recovery';
  readonly roomId: string;
  readonly boundaryEventId: string;
  readonly detail: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: 'open' | 'resolved';
}

export interface ConversationRecord {
  readonly id: string;
  readonly accountId: string;
  readonly key: string;
  readonly itemId: string;
}

export interface AccountSettingsRecord {
  readonly accountId: string;
  readonly schemaVersion: 2;
  readonly unacknowledgedAfterMs: number;
  readonly unacknowledgedRepeatMs: number;
  readonly acknowledgedAfterMs: number;
  readonly acknowledgedRepeatMs: number;
  readonly diagnosticsRetentionDays: number;
  readonly previewPrivacy: 'short' | 'generic';
  readonly audioEnabled: boolean;
  readonly audioVolume: number;
  readonly browserNotificationsEnabled: boolean;
  readonly webhookEnabled: boolean;
  readonly webhookPreset: 'generic' | 'ntfy';
  readonly webhookEndpoint: string;
  readonly webhookTopic: string;
  readonly webhookTimeoutMs: number;
  readonly webhookMaxAttempts: number;
  readonly updatedAt: number;
}

export type AlertTransportKind = 'audio' | 'browser_notification' | 'webhook';

export interface AlertDeliveryRecord {
  readonly id: string;
  readonly accountId: string;
  readonly effectId: string;
  readonly itemId: string;
  readonly transport: AlertTransportKind;
  readonly status: 'pending' | 'delivering' | 'delivered' | 'exhausted';
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly leaseUntil?: number | undefined;
  readonly deliveredAt?: number | undefined;
  readonly lastErrorCode?: string | undefined;
  readonly updatedAt: number;
}

export interface AlertAttemptRecord {
  readonly id: string;
  readonly accountId: string;
  readonly effectId: string;
  readonly deliveryId: string;
  readonly transport: AlertTransportKind;
  readonly attempt: number;
  readonly startedAt: number;
  readonly finishedAt?: number | undefined;
  readonly outcome: 'started' | 'delivered' | 'retry_scheduled' | 'exhausted';
  readonly responseStatus?: number | undefined;
  readonly errorCode?: string | undefined;
}

export interface MonitoringSessionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly startedAt: number;
  readonly stoppedAt?: number;
  readonly stopReason?: string;
}

export interface PersistedIngestionIssueRecord {
  readonly id: string;
  readonly accountId: string;
  readonly eventId?: string;
  readonly roomId?: string;
  readonly code: string;
  readonly detail: string;
  readonly detectedAt: number;
  readonly status: 'open' | 'resolved';
}

export interface QuarantinedRecord {
  readonly id: string;
  readonly accountId: string;
  readonly sourceStore: string;
  readonly sourceKey: string;
  readonly reason: string;
  readonly quarantinedAt: number;
  readonly redactedShape: readonly string[];
}

export class WorkflowDatabase extends Dexie {
  public coverageIssues!: EntityTable<PersistedCoverageIssue, 'id'>;
  public queueItems!: EntityTable<QueueItem, 'id'>;
  public activities!: EntityTable<QueueActivity, 'id'>;
  public conversationKeys!: EntityTable<ConversationRecord, 'id'>;
  public workflowTransitions!: EntityTable<WorkflowTransition, 'id'>;
  public alertEffects!: EntityTable<AlertEffect, 'id'>;
  public alertDeliveries!: EntityTable<AlertDeliveryRecord, 'id'>;
  public alertAttempts!: EntityTable<AlertAttemptRecord, 'id'>;
  public settings!: EntityTable<AccountSettingsRecord, 'accountId'>;
  public monitoringSessions!: EntityTable<MonitoringSessionRecord, 'id'>;
  public ingestionIssues!: EntityTable<PersistedIngestionIssueRecord, 'id'>;
  public quarantine!: EntityTable<QuarantinedRecord, 'id'>;

  public constructor(name: string) {
    super(name);
    this.version(1).stores({
      coverageIssues: 'id, [accountId+status], accountId, roomId, updatedAt',
    });
    this.version(2).stores({
      coverageIssues: 'id, [accountId+status], accountId, roomId, updatedAt',
      queueItems: 'id, accountId, [accountId+status], [accountId+updatedAt], conversationKey',
      activities: 'id, &[accountId+eventId], itemId, [accountId+itemId], detectedAt',
      conversationKeys: 'id, &[accountId+key], itemId',
      workflowTransitions: 'id, accountId, itemId, [accountId+itemId], at',
      alertEffects: 'id, accountId, itemId, [accountId+status], dueAt',
      settings: 'accountId, updatedAt',
      monitoringSessions: 'id, accountId, [accountId+startedAt]',
      ingestionIssues: 'id, [accountId+status], eventId, roomId, detectedAt',
      quarantine: 'id, accountId, sourceStore, quarantinedAt',
    });
    this.version(3)
      .stores({
        coverageIssues: 'id, [accountId+status], accountId, roomId, updatedAt',
        queueItems: 'id, accountId, [accountId+status], [accountId+updatedAt], conversationKey',
        activities: 'id, &[accountId+eventId], itemId, [accountId+itemId], detectedAt',
        conversationKeys: 'id, &[accountId+key], itemId',
        workflowTransitions: 'id, accountId, itemId, [accountId+itemId], at',
        alertEffects: 'id, accountId, itemId, [accountId+status], dueAt',
        alertDeliveries:
          'id, accountId, effectId, itemId, [accountId+status], [accountId+nextAttemptAt]',
        alertAttempts: 'id, accountId, effectId, deliveryId, [accountId+startedAt]',
        settings: 'accountId, updatedAt',
        monitoringSessions: 'id, accountId, [accountId+startedAt]',
        ingestionIssues: 'id, [accountId+status], eventId, roomId, detectedAt',
        quarantine: 'id, accountId, sourceStore, quarantinedAt',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table<AccountSettingsRecord, string>('settings')
          .toCollection()
          .modify((settings) => {
            Object.assign(settings, {
              schemaVersion: 2,
              audioVolume: 0.8,
              webhookPreset: 'generic',
              webhookEndpoint: '',
              webhookTopic: '',
              webhookTimeoutMs: 10_000,
              webhookMaxAttempts: 5,
            });
          });
      });
  }
}
