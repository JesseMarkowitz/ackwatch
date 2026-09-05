import type { AlertHealth, AlertRepositoryPort, GenericAlertPayload } from './alert-dispatcher';
import { AlertDispatcher, AlertScheduler, AlertTransportError } from './alert-dispatcher';
import type { Clock } from '../domain/clock';
import {
  AudioAlertTransport,
  BrowserNotificationTransport,
  type AudioLike,
  type NotificationConstructorLike,
} from '../infrastructure/browser/local-alert-transports';
import type { PolicyViolationLogPort } from '../infrastructure/browser/content-security-policy-log';
import type { WebhookCredentialStorePort } from '../infrastructure/browser/webhook-credential-store';
import { WebhookCredentialStore } from '../infrastructure/browser/webhook-credential-store';
import { WebhookTransport } from '../infrastructure/browser/webhook-transport';
import type { AccountSettingsRecord } from '../infrastructure/persistence/workflow-database';

/**
 * `untested` is configured but not yet exercised in this session.
 *
 * A webhook needs no permission from anyone, so reporting it as `permission_required` told the
 * operator to go and set up something that was already saved and working — and the state flipped to
 * ready the moment a test ran, which is the tell. Audio and notifications genuinely do require a
 * gesture or a grant, so `permission_required` stays honest for them.
 *
 * The distinction is deliberately not collapsed into `ready`: a channel that has never delivered
 * anything has not been shown to work, and this application has already shipped a webhook that was
 * broken in every browser while every indicator looked fine.
 */
export type AlertChannelState =
  'disabled' | 'untested' | 'ready' | 'permission_required' | 'retrying' | 'fault';

export interface AlertChannelsSnapshot {
  readonly audio: AlertChannelState;
  readonly notifications: AlertChannelState;
  readonly webhook: AlertChannelState;
  /**
   * Which sound the audio channel would play. A deployment can drop its own file in beside
   * `index.html`, and the operator who did that needs to see whether it was picked up — otherwise
   * the only way to tell a working custom tone from a silently ignored one is to recognise it.
   */
  readonly audioToneSource?: 'bundled' | 'custom' | 'unresolved';
  readonly audioDetail?: string | undefined;
  readonly notificationDetail?: string | undefined;
  readonly webhookDetail?: string | undefined;
}

export interface BrowserAlertCoordinatorPort {
  start(): void;
  stop(): void;
  dispatch(): Promise<void>;
  prepareForMonitoring(): Promise<void>;
  requestNotificationPermission(): Promise<void>;
  sendTestWebhook(): Promise<void>;
  sendTestAudio(): Promise<void>;
  setWebhookToken(token: string): void;
  clearWebhookToken(): void;
  snapshot(): AlertChannelsSnapshot;
}

export interface BrowserAlertDependencies {
  readonly notificationConstructor?: NotificationConstructorLike;
  readonly audioFactory?: (source: string) => AudioLike;
  readonly policyLog?: PolicyViolationLogPort;
  readonly credentialStore?: WebhookCredentialStorePort;
  readonly fetchFn?: typeof fetch;
  readonly windowTarget?: Window;
  readonly documentTarget?: Document;
  readonly onChange?: () => void;
}

export class BrowserAlertCoordinator implements BrowserAlertCoordinatorPort {
  private readonly audio: AudioAlertTransport;
  private readonly notifications: BrowserNotificationTransport;
  private readonly webhook: WebhookTransport;
  private readonly dispatcher: AlertDispatcher;
  private readonly scheduler: AlertScheduler;
  private state: AlertChannelsSnapshot;

  public constructor(
    private readonly repository: AlertRepositoryPort,
    private readonly accountId: string,
    private readonly clock: Clock,
    private readonly getSettings: () => AccountSettingsRecord,
    private readonly dependencies: BrowserAlertDependencies = {},
  ) {
    const settings = getSettings();
    this.state = {
      audio: settings.audioEnabled ? 'permission_required' : 'disabled',
      notifications: settings.browserNotificationsEnabled ? 'permission_required' : 'disabled',
      webhook: settings.webhookEnabled ? 'untested' : 'disabled',
    };
    this.audio =
      dependencies.audioFactory === undefined
        ? new AudioAlertTransport(() => this.getSettings().audioVolume)
        : new AudioAlertTransport(() => this.getSettings().audioVolume, dependencies.audioFactory);
    const notificationConstructor =
      dependencies.notificationConstructor ??
      (typeof Notification === 'undefined'
        ? undefined
        : (Notification as unknown as NotificationConstructorLike));
    this.notifications = new BrowserNotificationTransport(notificationConstructor);
    const credentials = dependencies.credentialStore ?? new WebhookCredentialStore();
    // Wrapped rather than passed bare for the reason documented on WebhookTransport's own default.
    const fetchFn: typeof fetch = dependencies.fetchFn ?? ((input, init) => fetch(input, init));
    this.webhook = new WebhookTransport(
      accountId,
      getSettings,
      credentials,
      fetchFn,
      dependencies.policyLog,
    );
    this.credentials = credentials;
    this.dispatcher = new AlertDispatcher(
      repository,
      clock,
      [this.audio, this.notifications, this.webhook],
      (health) => this.handleHealth(health),
    );
    const windowTarget = dependencies.windowTarget ?? window;
    const documentTarget = dependencies.documentTarget ?? document;
    this.scheduler = new AlertScheduler(() => this.dispatch(), {
      addEventListener: (type, listener) =>
        (type === 'visibilitychange' ? documentTarget : windowTarget).addEventListener(
          type,
          listener,
        ),
      removeEventListener: (type, listener) =>
        (type === 'visibilitychange' ? documentTarget : windowTarget).removeEventListener(
          type,
          listener,
        ),
    });
  }

  private readonly credentials: WebhookCredentialStorePort;

  public start(): void {
    this.scheduler.start();
  }

  public stop(): void {
    this.scheduler.stop();
  }

  public async dispatch(): Promise<void> {
    await this.dispatcher.dispatch(this.accountId);
    this.dependencies.onChange?.();
  }

  public async prepareForMonitoring(): Promise<void> {
    const settings = this.getSettings();
    if (settings.audioEnabled) {
      try {
        await this.audio.prepare();
        // `untested`, not `ready`. The unlock plays the clip muted, and browsers permit muted
        // playback unconditionally, so this resolving establishes that an audio element could
        // start — not that the operator can hear anything. Reporting `Ready` here is what let a
        // deployment where no tone was ever audible show a healthy indicator throughout. Only the
        // test tone or a delivered alert, both of which play unmuted at the configured volume,
        // move this to `ready`.
        this.setState({ audio: 'untested', audioDetail: undefined });
      } catch (error: unknown) {
        this.setState({ audio: 'fault', audioDetail: this.errorCode(error) });
      }
    }
    if (settings.browserNotificationsEnabled) await this.requestNotificationPermission();
  }

  public async requestNotificationPermission(): Promise<void> {
    try {
      const permission = await this.notifications.prepare();
      this.setState({
        notifications: permission === 'granted' ? 'ready' : 'fault',
        notificationDetail:
          permission === 'granted' ? undefined : `Notification permission is ${permission}.`,
      });
    } catch (error: unknown) {
      this.setState({ notifications: 'fault', notificationDetail: this.errorCode(error) });
    }
  }

  public async sendTestWebhook(): Promise<void> {
    const now = this.clock.now();
    const payload: GenericAlertPayload = {
      schema: 'ackwatch.alert.v1',
      effectId: `test:${now}`,
      reference: 'test',
      eventKind: 'new_activity',
      detectedAt: now,
      lastActivityAt: now,
      evaluatedAt: now,
      ageMs: 0,
      status: 'NEW',
      unseenCount: 1,
      escalationStage: 0,
      // Marked so a test can never be mistaken for real work needing attention.
      test: true,
    };
    try {
      await this.webhook.send(payload);
      this.setState({ webhook: 'ready', webhookDetail: undefined });
    } catch (error: unknown) {
      this.setState({ webhook: 'fault', webhookDetail: this.errorCode(error) });
      throw error;
    }
  }

  public async sendTestAudio(): Promise<void> {
    const now = this.clock.now();
    const payload: GenericAlertPayload = {
      schema: 'ackwatch.alert.v1',
      effectId: `test-audio:${now}`,
      reference: 'test',
      eventKind: 'new_activity',
      detectedAt: now,
      lastActivityAt: now,
      evaluatedAt: now,
      ageMs: 0,
      status: 'NEW',
      unseenCount: 1,
      escalationStage: 0,
      test: true,
    };
    try {
      // Unlocked first: a browser only permits sound after a gesture, and this runs inside the
      // click that asked for it, which is exactly the condition a real alert cannot rely on.
      await this.audio.prepare();
      // Unmuted, at the configured volume. This resolving is the strongest thing the application
      // can establish about audio — the browser accepted playback of an audible clip — and it is
      // what `ready` means for this channel. Whether a person heard it depends on the device
      // volume and, on iOS, the hardware silent switch, neither of which the page can observe.
      await this.audio.send(payload);
      this.setState({ audio: 'ready', audioDetail: undefined });
    } catch (error: unknown) {
      this.setState({ audio: 'fault', audioDetail: this.errorCode(error) });
      throw error;
    }
  }

  public setWebhookToken(token: string): void {
    this.credentials.write(this.accountId, token);
  }

  public clearWebhookToken(): void {
    this.credentials.clear(this.accountId);
  }

  public snapshot(): AlertChannelsSnapshot {
    const settings = this.getSettings();
    return {
      ...this.state,
      audioToneSource: this.audio.source(),
      audio: settings.audioEnabled
        ? this.state.audio === 'disabled'
          ? 'permission_required'
          : this.state.audio
        : 'disabled',
      notifications: settings.browserNotificationsEnabled
        ? this.state.notifications === 'disabled'
          ? 'permission_required'
          : this.state.notifications
        : 'disabled',
      webhook: settings.webhookEnabled
        ? this.state.webhook === 'disabled'
          ? 'untested'
          : this.state.webhook
        : 'disabled',
    };
  }

  private handleHealth(health: AlertHealth): void {
    const state =
      health.state === 'healthy' ? 'ready' : health.state === 'retrying' ? 'retrying' : 'fault';
    if (health.transport === 'audio') this.setState({ audio: state, audioDetail: health.detail });
    if (health.transport === 'browser_notification') {
      this.setState({ notifications: state, notificationDetail: health.detail });
    }
    if (health.transport === 'webhook') {
      this.setState({ webhook: state, webhookDetail: health.detail });
    }
  }

  private setState(patch: Partial<AlertChannelsSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.dependencies.onChange?.();
  }

  private errorCode(error: unknown): string {
    return error instanceof AlertTransportError
      ? error.underlying === undefined
        ? error.code
        : `${error.code} (${error.underlying})`
      : error instanceof Error
        ? error.message
        : 'Unknown alert failure.';
  }
}
