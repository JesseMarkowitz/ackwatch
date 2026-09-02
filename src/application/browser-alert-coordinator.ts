import type { AlertHealth, AlertRepositoryPort, GenericAlertPayload } from './alert-dispatcher';
import { AlertDispatcher, AlertScheduler, AlertTransportError } from './alert-dispatcher';
import type { Clock } from '../domain/clock';
import {
  AudioAlertTransport,
  BrowserNotificationTransport,
  type NotificationConstructorLike,
} from '../infrastructure/browser/local-alert-transports';
import type { WebhookCredentialStorePort } from '../infrastructure/browser/webhook-credential-store';
import { WebhookCredentialStore } from '../infrastructure/browser/webhook-credential-store';
import { WebhookTransport } from '../infrastructure/browser/webhook-transport';
import type { AccountSettingsRecord } from '../infrastructure/persistence/workflow-database';

export type AlertChannelState = 'disabled' | 'ready' | 'permission_required' | 'retrying' | 'fault';

export interface AlertChannelsSnapshot {
  readonly audio: AlertChannelState;
  readonly notifications: AlertChannelState;
  readonly webhook: AlertChannelState;
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
  setWebhookToken(token: string): void;
  clearWebhookToken(): void;
  snapshot(): AlertChannelsSnapshot;
}

export interface BrowserAlertDependencies {
  readonly notificationConstructor?: NotificationConstructorLike;
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
      webhook: settings.webhookEnabled ? 'permission_required' : 'disabled',
    };
    this.audio = new AudioAlertTransport(() => this.getSettings().audioVolume);
    const notificationConstructor =
      dependencies.notificationConstructor ??
      (typeof Notification === 'undefined'
        ? undefined
        : (Notification as unknown as NotificationConstructorLike));
    this.notifications = new BrowserNotificationTransport(notificationConstructor);
    const credentials = dependencies.credentialStore ?? new WebhookCredentialStore();
    this.webhook =
      dependencies.fetchFn === undefined
        ? new WebhookTransport(accountId, getSettings, credentials)
        : new WebhookTransport(accountId, getSettings, credentials, dependencies.fetchFn);
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
        this.setState({ audio: 'ready', audioDetail: undefined });
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
      eventKind: 'new_activity',
      detectedAt: now,
      evaluatedAt: now,
      ageMs: 0,
      status: 'NEW',
      unseenCount: 1,
      escalationStage: 0,
    };
    try {
      await this.webhook.send(payload);
      this.setState({ webhook: 'ready', webhookDetail: undefined });
    } catch (error: unknown) {
      this.setState({ webhook: 'fault', webhookDetail: this.errorCode(error) });
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
          ? 'permission_required'
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
      ? error.code
      : error instanceof Error
        ? error.message
        : 'Unknown alert failure.';
  }
}
