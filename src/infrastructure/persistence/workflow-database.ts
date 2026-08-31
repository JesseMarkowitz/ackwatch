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
  readonly schemaVersion: 1;
  readonly unacknowledgedAfterMs: number;
  readonly unacknowledgedRepeatMs: number;
  readonly acknowledgedAfterMs: number;
  readonly acknowledgedRepeatMs: number;
  readonly diagnosticsRetentionDays: number;
  readonly previewPrivacy: 'short' | 'generic';
  readonly audioEnabled: boolean;
  readonly browserNotificationsEnabled: boolean;
  readonly webhookEnabled: boolean;
  readonly updatedAt: number;
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
  }
}
