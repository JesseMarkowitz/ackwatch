import {
  AlertTransportError,
  type AlertTransport,
  type GenericAlertPayload,
} from '../../application/alert-dispatcher';

// A short 8-bit PCM WAV tone bundled into the production JavaScript; no network asset is loaded.
const alertTone =
  'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAqb/Jx6mAYDc5Y6vPyp+AgA==';

export interface AudioLike {
  volume: number;
  muted: boolean;
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}

export class AudioAlertTransport implements AlertTransport {
  public readonly kind = 'audio' as const;
  private unlocked = false;

  public constructor(
    private readonly volume: () => number,
    private readonly createAudio: (source: string) => AudioLike = (source) => new Audio(source),
  ) {}

  public async prepare(): Promise<void> {
    const audio = this.createAudio(alertTone);
    audio.muted = true;
    try {
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      this.unlocked = true;
    } catch {
      this.unlocked = false;
      throw new AlertTransportError('AUDIO_UNLOCK_FAILED', false);
    }
  }

  public async send(payload: GenericAlertPayload): Promise<Record<string, never>> {
    void payload;
    if (!this.unlocked) throw new AlertTransportError('AUDIO_NOT_READY', false);
    const audio = this.createAudio(alertTone);
    audio.volume = this.volume();
    audio.muted = false;
    try {
      await audio.play();
      return {};
    } catch {
      throw new AlertTransportError('AUDIO_PLAYBACK_FAILED', false);
    }
  }
}

export interface NotificationConstructorLike {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): Notification;
}

export class BrowserNotificationTransport implements AlertTransport {
  public readonly kind = 'browser_notification' as const;

  public constructor(private readonly notifications?: NotificationConstructorLike) {}

  public async prepare(): Promise<NotificationPermission> {
    if (!this.notifications) throw new AlertTransportError('NOTIFICATIONS_UNSUPPORTED', false);
    return this.notifications.permission === 'default'
      ? await this.notifications.requestPermission()
      : this.notifications.permission;
  }

  public async send(payload: GenericAlertPayload): Promise<Record<string, never>> {
    if (!this.notifications) throw new AlertTransportError('NOTIFICATIONS_UNSUPPORTED', false);
    if (this.notifications.permission !== 'granted') {
      throw new AlertTransportError('NOTIFICATION_PERMISSION_DENIED', false);
    }
    new this.notifications('AckWatch attention required', {
      body: 'Matrix activity needs attention.',
      tag: `ackwatch:${payload.effectId}`,
    });
    return {};
  }
}
