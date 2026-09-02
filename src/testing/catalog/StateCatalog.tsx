import { useEffect } from 'react';

import type { AppSnapshot } from '../../application/app-controller';
import { App } from '../../app/App';
import type { QueueActivity, QueueItem } from '../../domain/queue';
import { defaultAccountSettings } from '../../infrastructure/persistence/workflow-repository';

const baseCoverage: AppSnapshot['coverage'] = {
  connection: 'ready',
  monitoring: 'off',
  networkBaselineConfirmed: true,
  ingestionPending: 0,
  openGapCount: 0,
  lastConfirmedAt: Date.UTC(2026, 7, 31, 13, 41),
};

const signedOut: AppSnapshot = {
  phase: 'signed_out',
  accountLabel: 'Not signed in',
  coverage: {
    connection: 'signed_out',
    monitoring: 'off',
    networkBaselineConfirmed: false,
    ingestionPending: 0,
    openGapCount: 0,
  },
  activities: [],
  ingestionIssues: [],
  ingestionDecisions: [],
  queueItems: [],
  queueActivities: [],
  storage: { available: true, persistenceSupported: true, persistent: false },
  alerts: { audio: 'disabled', notifications: 'disabled', webhook: 'disabled' },
  crypto: {
    state: 'off',
    crossSigningReady: false,
    secretStorageReady: false,
    keyBackupReady: false,
    verification: 'idle',
  },
};

const active = (coverage: Partial<AppSnapshot['coverage']> = {}): AppSnapshot => ({
  phase: 'active',
  accountLabel: '@operator:example.test',
  homeserverLabel: 'https://matrix.example.test',
  coverage: { ...baseCoverage, ...coverage },
  activities: [],
  ingestionIssues: [],
  ingestionDecisions: [],
  queueItems: [],
  queueActivities: [],
  storage: { available: true, persistenceSupported: true, persistent: false },
  alerts: {
    audio: 'permission_required',
    notifications: 'permission_required',
    webhook: 'disabled',
  },
  crypto: {
    state: 'ready',
    crossSigningReady: false,
    secretStorageReady: false,
    keyBackupReady: false,
    verification: 'idle',
  },
  settings: {
    ...defaultAccountSettings(
      '@operator:example.test|https://matrix.example.test',
      Date.UTC(2026, 7, 31, 13, 40),
    ),
    audioEnabled: true,
    browserNotificationsEnabled: true,
  },
});

const receivedAt = Date.UTC(2026, 7, 31, 13, 42);
const queueActivity = (
  eventId: string,
  itemId: string,
  preview: string,
  sequence: number,
): QueueActivity => ({
  id: `@operator:example.test|${eventId}`,
  accountId: '@operator:example.test|https://matrix.example.test',
  eventId,
  itemId,
  roomId: '!operations:example.test',
  roomName: 'Operations desk',
  sender: '@dispatch:example.test',
  eventType: 'm.room.message',
  messageType: 'm.text',
  preview,
  detectedAt: receivedAt + sequence,
  localSequence: sequence,
  provenance: 'live',
  contentState: 'clear',
  edited: false,
  redacted: false,
  relationKind: 'independent',
});
const queueItem = (id: string, status: QueueItem['status']): QueueItem => ({
  id,
  accountId: '@operator:example.test|https://matrix.example.test',
  conversationKey: `event:!operations:example.test:$${id}`,
  roomId: '!operations:example.test',
  cycleId: `cycle-${id}`,
  status,
  activityCount: 1,
  unseenActivityCount: status === 'NEW' ? 1 : 0,
  needsAttention: status === 'NEW',
  firstDetectedAt: receivedAt,
  lastActivityAt: receivedAt,
  createdAt: receivedAt,
  updatedAt: receivedAt,
  reopenedCount: 0,
  ...(status === 'COMPLETED'
    ? { completedAt: receivedAt + 60_000 }
    : {
        deadline: {
          kind: status === 'ACKNOWLEDGED' ? 'acknowledged' : 'unacknowledged',
          firstAt: receivedAt + (status === 'ACKNOWLEDGED' ? 1_800_000 : 300_000),
          repeatEveryMs: status === 'ACKNOWLEDGED' ? 900_000 : 300_000,
        } as const,
      }),
});

const attentionItem = queueItem('attention', 'NEW');
const openItem = queueItem('open', 'ACKNOWLEDGED');
const completedItem = queueItem('completed', 'COMPLETED');
const encryptedItem = queueItem('encrypted', 'NEW');
const overdueItem: QueueItem = {
  ...queueItem('overdue', 'UNACKNOWLEDGED'),
  deadline: {
    kind: 'unacknowledged',
    firstAt: receivedAt - 60_000,
    repeatEveryMs: 300_000,
  },
};
const workflowActivities = [
  queueActivity(
    '$attention',
    attentionItem.id,
    'Service check requires review before the next handoff.',
    1,
  ),
  queueActivity('$open', openItem.id, 'Waiting on the maintenance window owner.', 2),
  queueActivity(
    '$completed',
    completedItem.id,
    'Deployment verification finished successfully.',
    3,
  ),
];

const fixtures = {
  armed: active({ monitoring: 'armed' }),
  baseline: {
    ...active(),
    coverage: {
      connection: 'baseline_syncing',
      monitoring: 'off',
      networkBaselineConfirmed: false,
      ingestionPending: 0,
      openGapCount: 0,
    },
  },
  incomplete: {
    ...active({ connection: 'coverage_incomplete', monitoring: 'armed', openGapCount: 1 }),
    error: 'Gap pagination ended before the known boundary. Retry remains available.',
  },
  ready: active(),
  received: {
    ...active({ monitoring: 'armed' }),
    activities: [
      {
        kind: 'activity',
        accountId: '@operator:example.test|https://matrix.example.test',
        eventId: '$synthetic-event:example.test',
        roomId: '!operations:example.test',
        roomName: 'Operations desk',
        sender: '@dispatch:example.test',
        eventType: 'm.room.message',
        messageType: 'm.text',
        preview: 'Service check requires review before the next handoff.',
        detectedAt: Date.UTC(2026, 7, 31, 13, 42),
        localSequence: 1,
        provenance: 'live',
        contentState: 'clear',
        relationKind: 'independent',
      },
    ],
    queueItems: [attentionItem],
    queueActivities: [workflowActivities[0] as QueueActivity],
  },
  workflow: {
    ...active({ monitoring: 'armed' }),
    queueItems: [attentionItem, openItem, completedItem],
    queueActivities: workflowActivities,
  },
  overdue: {
    ...active({ monitoring: 'armed' }),
    queueItems: [overdueItem],
    queueActivities: [
      queueActivity('$overdue', overdueItem.id, 'Awaiting review past the first deadline.', 4),
    ],
    alertDeliveries: [
      {
        id: 'effect-overdue|webhook',
        accountId: overdueItem.accountId,
        effectId: 'effect-overdue',
        itemId: overdueItem.id,
        transport: 'webhook',
        status: 'pending',
        attemptCount: 1,
        nextAttemptAt: receivedAt + 1_000,
        updatedAt: receivedAt,
        lastErrorCode: 'HTTP_429',
      },
    ],
    alerts: { audio: 'ready', notifications: 'ready', webhook: 'retrying' },
  },
  'encrypted-placeholder': {
    ...active({ monitoring: 'armed' }),
    queueItems: [encryptedItem],
    queueActivities: [
      {
        ...queueActivity(
          '$encrypted',
          encryptedItem.id,
          'Encrypted message—waiting for room keys',
          5,
        ),
        eventType: 'm.room.encrypted',
        messageType: 'm.room.encrypted',
        contentState: 'unavailable',
        decryptionFailureCode: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID',
      },
    ],
  },
  'alerts-ready': {
    ...active({ monitoring: 'armed' }),
    alerts: { audio: 'ready', notifications: 'ready', webhook: 'ready' },
    settings: {
      ...active().settings!,
      webhookEnabled: true,
      webhookPreset: 'ntfy',
      webhookEndpoint: 'https://alerts.example.test',
      webhookTopic: 'ackwatch-synthetic',
    },
  },
  'alert-faults': {
    ...active({ monitoring: 'armed' }),
    alerts: {
      audio: 'fault',
      notifications: 'fault',
      webhook: 'fault',
      audioDetail: 'Audio playback was blocked by the browser.',
      notificationDetail: 'Notification permission is denied.',
      webhookDetail: 'AUTHENTICATION_FAILED',
    },
    settings: {
      ...active().settings!,
      webhookEnabled: true,
      webhookEndpoint: 'https://alerts.example.test/hook',
    },
    alertDeliveries: [
      {
        id: 'effect-fault|webhook',
        accountId: overdueItem.accountId,
        effectId: 'effect-fault',
        itemId: overdueItem.id,
        transport: 'webhook',
        status: 'exhausted',
        attemptCount: 4,
        nextAttemptAt: receivedAt,
        updatedAt: receivedAt,
        lastErrorCode: 'AUTHENTICATION_FAILED',
      },
    ],
  },
  'crypto-fault': {
    ...active({ connection: 'fatal_error' }),
    crypto: {
      state: 'fault',
      crossSigningReady: false,
      secretStorageReady: false,
      keyBackupReady: false,
      verification: 'idle',
      detail: 'Rust crypto storage could not be initialized. Monitoring was disarmed.',
    },
  },
  'storage-fault': {
    ...active({ connection: 'fatal_error' }),
    storage: {
      available: true,
      persistenceSupported: true,
      persistent: false,
      fault: 'Workflow storage closed unexpectedly. Durable acceptance is unavailable.',
    },
  },
  reconnecting: active({ connection: 'reconnecting', monitoring: 'armed' }),
  recovering: active({ connection: 'recovering_gap', monitoring: 'armed', openGapCount: 1 }),
  'second-tab': {
    ...active(),
    phase: 'blocked',
    error: 'Another AckWatch tab owns this Matrix account session.',
  },
  'signed-out': signedOut,
} satisfies Record<string, AppSnapshot>;

export type CatalogState = keyof typeof fixtures;

function isCatalogState(value: string | null): value is CatalogState {
  return value !== null && Object.hasOwn(fixtures, value);
}

export function StateCatalog() {
  const requestedState = new URLSearchParams(window.location.search).get('state');
  const state = isCatalogState(requestedState) ? requestedState : 'signed-out';

  useEffect(() => {
    document.documentElement.dataset.catalogState = state;
  }, [state]);

  return <App snapshot={fixtures[state]} />;
}
