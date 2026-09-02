import { describe, expect, it, vi } from 'vitest';

import type { GenericAlertPayload } from '../../application/alert-dispatcher';
import {
  AudioAlertTransport,
  BrowserNotificationTransport,
  type AudioLike,
  type NotificationConstructorLike,
} from './local-alert-transports';

const payload: GenericAlertPayload = {
  schema: 'ackwatch.alert.v1',
  effectId: 'effect',
  eventKind: 'new_activity',
  detectedAt: 1,
  evaluatedAt: 1,
  ageMs: 0,
  status: 'NEW',
  unseenCount: 1,
  escalationStage: 0,
};

describe('local alert transports', () => {
  it('unlocks bundled audio during a user gesture before later playback', async () => {
    const created: AudioLike[] = [];
    const createAudio = () => {
      const audio: AudioLike = {
        volume: 1,
        muted: false,
        currentTime: 0,
        play: vi.fn(async () => undefined),
        pause: vi.fn(),
      };
      created.push(audio);
      return audio;
    };
    const transport = new AudioAlertTransport(() => 0.4, createAudio);

    await expect(transport.send(payload)).rejects.toThrow('AUDIO_NOT_READY');
    await transport.prepare();
    await transport.send(payload);

    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ muted: true, currentTime: 0 });
    expect(created[1]).toMatchObject({ muted: false, volume: 0.4 });
  });

  it('requests notification permission explicitly and uses a deterministic tag', async () => {
    const shown: Array<{ title: string; options?: NotificationOptions }> = [];
    class FakeNotification {
      public static permission: NotificationPermission = 'default';
      public static async requestPermission(): Promise<NotificationPermission> {
        FakeNotification.permission = 'granted';
        return 'granted';
      }
      public constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, ...(options === undefined ? {} : { options }) });
      }
    }
    const transport = new BrowserNotificationTransport(
      FakeNotification as unknown as NotificationConstructorLike,
    );

    await expect(transport.prepare()).resolves.toBe('granted');
    await transport.send(payload);

    expect(shown).toEqual([
      expect.objectContaining({
        title: 'AckWatch attention required',
        options: expect.objectContaining({ tag: 'ackwatch:effect' }),
      }),
    ]);
  });
});
