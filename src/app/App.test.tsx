import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import type { AckWatchControllerPort, AppSnapshot } from '../application/app-controller';

afterEach(cleanup);

describe('foundation shell', () => {
  it('explains the session boundary and accepts a Matrix user ID without navigation', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole('heading', { name: /important messages/i })).toBeInTheDocument();
    expect(screen.getByText(/validates discovery/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/matrix user id/i), '@operator:example.test');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByLabelText(/matrix user id/i)).toHaveValue('@operator:example.test');
  });

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = render(<App />);
    const result = await axe.run(container);

    expect(result.violations).toEqual([]);
  });

  it('uses domain commands for details/actions and keeps Matrix link actions state-neutral', async () => {
    const applyQueueCommand = vi.fn(async () => undefined);
    const snapshot: AppSnapshot = {
      phase: 'active',
      session: { state: 'active', startedAt: 0, continuityWindowMs: 12 * 60 * 60_000 },
      accountLabel: '@operator:example.test',
      homeserverLabel: 'https://example.test',
      coverage: {
        connection: 'ready',
        monitoring: 'armed',
        networkBaselineConfirmed: true,
        ingestionPending: 0,
        openGapCount: 0,
      },
      activities: [],
      ingestionIssues: [],
      ingestionDecisions: [],
      storage: { available: true, persistenceSupported: false },
      alerts: { audio: 'disabled', notifications: 'disabled', webhook: 'disabled' },
      crypto: {
        state: 'ready',
        crossSigningReady: false,
        secretStorageReady: false,
        keyBackupReady: false,
        verification: 'idle',
      },
      queueItems: [
        {
          id: 'item-a',
          accountId: '@operator:example.test|https://example.test',
          conversationKey: 'event:!room:example.test:$event',
          roomId: '!room:example.test',
          cycleId: 'cycle-a',
          status: 'NEW',
          activityCount: 1,
          unseenActivityCount: 1,
          needsAttention: true,
          firstDetectedAt: 1_000,
          lastActivityAt: 1_000,
          createdAt: 1_000,
          updatedAt: 1_000,
          reopenedCount: 0,
          deadline: { kind: 'unacknowledged', firstAt: 301_000, repeatEveryMs: 300_000 },
        },
      ],
      queueActivities: [
        {
          id: 'activity-a',
          accountId: '@operator:example.test|https://example.test',
          eventId: '$event',
          itemId: 'item-a',
          roomId: '!room:example.test',
          sender: '@sender:example.test',
          eventType: 'm.room.message',
          messageType: 'm.text',
          preview: '<b>rendered as text</b>',
          detectedAt: 1_000,
          localSequence: 1,
          provenance: 'live',
          contentState: 'clear',
          edited: false,
          redacted: false,
          relationKind: 'independent',
        },
      ],
    };
    const controller: AckWatchControllerPort = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      continueInterruptedSession: async () => undefined,
      startNewSession: async () => undefined,
      endSession: async () => undefined,
      initialize: async () => undefined,
      prepareLogin: async () => undefined,
      login: async () => undefined,
      startMonitoring: () => undefined,
      stopMonitoring: () => undefined,
      retryCoverage: async () => undefined,
      applyQueueCommand,
      requestPersistentStorage: async () => undefined,
      exportSettings: async () => undefined,
      importSettings: async () => undefined,
      updateSettings: async () => undefined,
      requestNotificationPermission: async () => undefined,
      setWebhookToken: () => undefined,
      sendTestWebhook: async () => undefined,
      retryAlertDelivery: async () => undefined,
      resolveEventDetail: async (roomId, eventId) => ({
        availability: 'available',
        roomId,
        eventId,
        roomName: 'Operations',
        sender: '@sender:example.test',
        originServerTs: 1_000,
        eventType: 'm.room.message',
        messageType: 'm.text',
        body: 'Complete decrypted body',
        relationKind: 'independent',
        encrypted: false,
        edited: false,
        redacted: false,
      }),
      bootstrapCryptoSecurity: async () => 'recovery-key',
      restoreCryptoSecurity: async () => undefined,
      requestOwnDeviceVerification: async () => undefined,
      acceptVerificationRequest: async () => undefined,
      startSasVerification: async () => undefined,
      confirmSasVerification: async () => undefined,
      cancelOwnDeviceVerification: async () => undefined,
      logout: async () => undefined,
    };
    const user = userEvent.setup();
    const { container } = render(<App controller={controller} />);

    expect(container.querySelector('b')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'View details' }));
    expect(applyQueueCommand).toHaveBeenCalledTimes(1);
    expect(applyQueueCommand).toHaveBeenLastCalledWith('item-a', 'mark_viewed');
    expect(screen.getByRole('link', { name: 'Open in Matrix' })).toHaveAttribute(
      'href',
      'matrix:roomid/room%3Aexample.test/e/event',
    );
    await user.click(screen.getByRole('button', { name: 'Copy Matrix URI' }));
    expect(applyQueueCommand).toHaveBeenCalledTimes(1);
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
