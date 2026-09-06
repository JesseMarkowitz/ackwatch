import { useEffect } from 'react';

import type { AckWatchControllerPort, AppSnapshot } from '../../application/app-controller';
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
  session: { state: 'none', continuityWindowMs: 12 * 60 * 60_000 },
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
  session: {
    state: 'active',
    startedAt: Date.UTC(2026, 7, 31, 9, 0),
    continuityWindowMs: 12 * 60 * 60_000,
  },
  homeserverLabel: 'https://matrix.example.test',
  coverage: { ...baseCoverage, ...coverage },
  activities: [],
  ingestionIssues: [],
  ingestionDecisions: [],
  queueItems: [],
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
const queueItem = (
  id: string,
  status: QueueItem['status'],
  preview = 'Service check requires review before the next handoff.',
): QueueItem => ({
  latestActivity: {
    eventId: `$${id}`,
    sender: '@dispatch:example.test',
    preview,
    roomName: 'Operations desk',
  },
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

// Marked direct so the label that distinguishes a request addressed to the operator appears in a
// baseline rather than only in the code that draws it.
const attentionItem = { ...queueItem('attention', 'NEW'), direct: true, encrypted: true };
const openItem = queueItem('open', 'ACKNOWLEDGED', 'Waiting on the maintenance window owner.');
const completedItem = queueItem(
  'completed',
  'COMPLETED',
  'Deployment verification finished successfully.',
);

/**
 * A room with no name, so the card falls back to its id. Real ids are long and have nothing to
 * break at, and every fixture using a friendly name is why a card spilling outside its column
 * never appeared in a baseline.
 */
const unnamedRoomItem: QueueItem = {
  ...queueItem('unnamed', 'COMPLETED', 'Verified the overnight batch and closed it out.'),
  roomId: '!QzXvBnMlKjHgFdSaPoIuYtReWq0123456789:matrix.example.test',
  latestActivity: {
    eventId: '$unnamed',
    sender: '@dispatch:example.test',
    preview: 'Verified the overnight batch and closed it out.',
  },
};
const encryptedItem = queueItem('encrypted', 'NEW', 'Encrypted message—waiting for keys');
const overdueItem: QueueItem = {
  ...queueItem('overdue', 'UNACKNOWLEDGED', 'Awaiting review past the first deadline.'),
  deadline: {
    kind: 'unacknowledged',
    firstAt: receivedAt - 60_000,
    repeatEveryMs: 300_000,
  },
};
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
        encrypted: false,
        attention: 'requires_attention',
        addressing: 'ambient',
      },
    ],
    queueItems: [attentionItem],
  },
  workflow: {
    ...active({ monitoring: 'armed' }),
    queueItems: [attentionItem, openItem, completedItem, unnamedRoomItem],
  },
  overdue: {
    ...active({ monitoring: 'armed' }),
    queueItems: [overdueItem],
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
  'session-interrupted': {
    ...active(),
    session: {
      state: 'interrupted',
      startedAt: Date.UTC(2026, 7, 31, 9, 0),
      continuityWindowMs: 12 * 60 * 60_000,
    },
  },
  'session-archived': {
    ...active(),
    session: {
      state: 'active',
      startedAt: Date.UTC(2026, 7, 31, 9, 0),
      continuityWindowMs: 12 * 60 * 60_000,
      notice:
        'The previous session was older than the continuity window, so it was archived and a new session started.',
    },
  },
  'signed-out': signedOut,
} satisfies Record<string, AppSnapshot>;

/**
 * The detail dialog's history is loaded from the controller rather than read off the snapshot, so
 * the catalog has to supply one to render it at all. Only the one method is implemented: this
 * exists to put reactions and the operator's own messages into an approved baseline, which is
 * otherwise the one part of the interface no screenshot covers.
 */
const conversationActivities: readonly QueueActivity[] = [
  {
    id: 'activity-root',
    accountId: attentionItem.accountId,
    eventId: '$attention',
    itemId: attentionItem.id,
    roomId: attentionItem.roomId,
    roomName: 'Operations desk',
    sender: '@dispatch:example.test',
    eventType: 'm.room.message',
    messageType: 'm.text',
    preview: 'Service check requires review before the next handoff.',
    detectedAt: receivedAt,
    localSequence: 1,
    provenance: 'live',
    contentState: 'clear',
    edited: false,
    redacted: false,
    relationKind: 'independent',
    encrypted: true,
    attention: 'requires_attention',
    addressing: 'direct',
  },
  {
    id: 'activity-own',
    accountId: attentionItem.accountId,
    eventId: '$own-reply',
    itemId: attentionItem.id,
    roomId: attentionItem.roomId,
    roomName: 'Operations desk',
    sender: '@operator:example.test',
    eventType: 'm.room.message',
    messageType: 'm.text',
    preview: 'Looking at it now — will confirm before the handoff.',
    detectedAt: receivedAt + 120_000,
    localSequence: 2,
    provenance: 'live',
    contentState: 'clear',
    edited: false,
    redacted: false,
    relationKind: 'thread',
    relationEventId: '$attention',
    encrypted: true,
    attention: 'context_only',
    addressing: 'ambient',
  },
  {
    id: 'activity-reaction',
    accountId: attentionItem.accountId,
    eventId: '$reaction',
    itemId: attentionItem.id,
    roomId: attentionItem.roomId,
    roomName: 'Operations desk',
    sender: '@dispatch:example.test',
    eventType: 'm.reaction',
    messageType: 'm.reaction',
    preview: 'Reacted \u{1F44D}',
    detectedAt: receivedAt + 180_000,
    localSequence: 3,
    provenance: 'live',
    contentState: 'clear',
    edited: false,
    redacted: false,
    relationKind: 'reaction',
    relationEventId: '$attention',
    encrypted: false,
    attention: 'requires_attention',
    addressing: 'ambient',
  },
];

const catalogController = {
  loadItemActivities: async () => conversationActivities,
  // The dialog resolves the newest message in full from the Matrix client. There is no client
  // here, so it reports the same unavailability a real one does when detail cannot be fetched —
  // which is itself a state worth having in a baseline.
  resolveEventDetail: async () => undefined,
} as unknown as AckWatchControllerPort;

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

  return <App controller={catalogController} snapshot={fixtures[state]} />;
}
