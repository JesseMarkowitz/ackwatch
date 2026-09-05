import {
  AlertTransportError,
  alertMessage,
  type AlertTransport,
  type GenericAlertPayload,
} from '../../application/alert-dispatcher';

import { bundledAlertTone } from './alert-tone';
import {
  resolveAlertTone,
  type ResolvedAlertTone,
  type TonePresenceProbe,
} from './alert-tone-source';

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
  private resolving: Promise<ResolvedAlertTone> | undefined;
  private resolved: ResolvedAlertTone | undefined;

  public constructor(
    private readonly volume: () => number,
    private readonly createAudio: (source: string) => AudioLike = (source) => new Audio(source),
    private readonly probe?: TonePresenceProbe,
  ) {}

  /**
   * Resolved once and reused. A deployment's tone does not appear or vanish mid-session, and
   * probing at every alert would put two requests in front of every escalation.
   */
  private async tone(): Promise<ResolvedAlertTone> {
    this.resolving ??= (
      this.probe === undefined ? resolveAlertTone() : resolveAlertTone(this.probe)
    )
      // A probe that throws must never cost the operator their alert: fall back to the tone that
      // is compiled in and cannot fail to be there.
      .catch((): ResolvedAlertTone => ({ source: bundledAlertTone, custom: undefined }))
      .then((tone) => {
        this.resolved = tone;
        return tone;
      });
    return this.resolving;
  }

  /** Which tone last played, so an interface can tell a deployer their file was picked up. */
  public source(): 'bundled' | 'custom' | 'unresolved' {
    if (!this.resolved) return 'unresolved';
    return this.resolved.custom === undefined ? 'bundled' : 'custom';
  }

  /**
   * Opens the autoplay gate, and establishes nothing about audibility. The clip is played muted,
   * and browsers permit muted playback unconditionally, so this resolves on a machine where sound
   * is impossible. Callers must not report a channel as ready on the strength of it; only `send`
   * plays unmuted.
   */
  public async prepare(): Promise<void> {
    const { source } = await this.tone();
    const audio = this.createAudio(source);
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
    const { source } = await this.tone();
    const audio = this.createAudio(source);
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
    // The same sentence every other transport sends, including the item reference printed on the
    // card. A notification saying only "Matrix activity needs attention" cannot be acted on without
    // opening the app to work out which item it meant.
    new this.notifications(
      payload.test ? 'AckWatch test notification' : 'AckWatch: attention required',
      {
        body: alertMessage(payload),
        tag: `ackwatch:${payload.effectId}`,
      },
    );
    return {};
  }
}
