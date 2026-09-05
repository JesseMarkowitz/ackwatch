import { describe, expect, it, vi } from 'vitest';

import type { AlertRepositoryPort } from './alert-dispatcher';
import { BrowserAlertCoordinator } from './browser-alert-coordinator';
import type { AudioLike } from '../infrastructure/browser/local-alert-transports';
import type { WebhookCredentialStorePort } from '../infrastructure/browser/webhook-credential-store';
import type { AccountSettingsRecord } from '../infrastructure/persistence/workflow-database';

const settings: AccountSettingsRecord = {
  accountId: 'account',
  schemaVersion: 3,
  unacknowledgedAfterMs: 60_000,
  unacknowledgedRepeatMs: 60_000,
  acknowledgedAfterMs: 60_000,
  acknowledgedRepeatMs: 60_000,
  diagnosticsRetentionDays: 7,
  sessionContinuityWindowMs: 43_200_000,
  previewPrivacy: 'short',
  audioEnabled: true,
  audioVolume: 0.4,
  browserNotificationsEnabled: false,
  webhookEnabled: false,
  webhookPreset: 'generic',
  webhookEndpoint: '',
  webhookTopic: '',
  webhookTimeoutMs: 5_000,
  webhookMaxAttempts: 3,
  updatedAt: 0,
};

const credentialStore: WebhookCredentialStorePort = {
  read: () => undefined,
  write: () => undefined,
  clear: () => undefined,
};

/**
 * `mutedOnly` models the machine the operator actually had: muted playback is permitted, audible
 * playback is not. Every browser behaves this way when no gesture has been made, which is why a
 * muted unlock cannot license a readiness claim.
 */
function audioFactory(options: { readonly mutedOnly: boolean }): (source: string) => AudioLike {
  return () => {
    const audio: AudioLike = {
      volume: 1,
      muted: false,
      currentTime: 0,
      play: vi.fn(async () => {
        if (options.mutedOnly && !audio.muted) throw new Error('NotAllowedError');
      }),
      pause: vi.fn(),
    };
    return audio;
  };
}

function coordinator(options: { readonly mutedOnly: boolean }): BrowserAlertCoordinator {
  return new BrowserAlertCoordinator(
    {} as unknown as AlertRepositoryPort,
    'account',
    { now: () => 1_000 },
    () => settings,
    { audioFactory: audioFactory(options), credentialStore },
  );
}

describe('browser alert coordinator audio readiness', () => {
  it('reports audio as untested after the muted unlock, because muted playback proves nothing', async () => {
    const alerts = coordinator({ mutedOnly: true });

    await alerts.prepareForMonitoring();

    // The unlock resolved — muted playback is always permitted — and the channel must still not
    // claim to be ready. This is the defect the live test found: the indicator read Ready on a
    // deployment where no tone was ever audible.
    expect(alerts.snapshot().audio).toBe('untested');
  });

  it('reports audio as ready only once the tone has played unmuted', async () => {
    const alerts = coordinator({ mutedOnly: false });

    await alerts.prepareForMonitoring();
    expect(alerts.snapshot().audio).toBe('untested');

    await alerts.sendTestAudio();

    expect(alerts.snapshot().audio).toBe('ready');
  });

  it('reports a fault when the test tone is refused, rather than falling back to the unlock', async () => {
    const alerts = coordinator({ mutedOnly: true });

    await alerts.prepareForMonitoring();
    await expect(alerts.sendTestAudio()).rejects.toThrow();

    expect(alerts.snapshot().audio).toBe('fault');
    expect(alerts.snapshot().audioDetail).toBe('AUDIO_PLAYBACK_FAILED');
  });
});
