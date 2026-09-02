import type { Clock } from '../domain/clock';
import type { AlertEffect, QueueItem } from '../domain/queue';
import type {
  AccountSettingsRecord,
  AlertDeliveryRecord,
  AlertTransportKind,
} from '../infrastructure/persistence/workflow-database';

export interface GenericAlertPayload {
  readonly schema: 'ackwatch.alert.v1';
  readonly effectId: string;
  readonly eventKind: 'new_activity' | 'reopened_activity' | 'unacknowledged' | 'pending_work';
  readonly detectedAt: number;
  readonly evaluatedAt: number;
  readonly ageMs: number;
  readonly status: QueueItem['status'];
  readonly unseenCount: number;
  readonly escalationStage: number;
}

export interface AlertTransportResult {
  readonly responseStatus?: number;
}

export interface AlertTransport {
  readonly kind: AlertTransportKind;
  send(payload: GenericAlertPayload): Promise<AlertTransportResult>;
}

export class AlertTransportError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly responseStatus?: number,
  ) {
    super(code);
    this.name = 'AlertTransportError';
  }
}

export interface AlertRepositoryPort {
  getSettings(accountId: string): Promise<AccountSettingsRecord>;
  alertEffect(accountId: string, effectId: string): Promise<AlertEffect | undefined>;
  queueItem(accountId: string, itemId: string): Promise<QueueItem | undefined>;
  prepareDueAlertDeliveries(
    accountId: string,
    now: number,
    transports: readonly AlertTransportKind[],
  ): Promise<readonly AlertDeliveryRecord[]>;
  claimAlertDelivery(
    accountId: string,
    deliveryId: string,
    now: number,
  ): Promise<AlertDeliveryRecord | undefined>;
  settleAlertDelivery(
    accountId: string,
    deliveryId: string,
    result:
      | { readonly status: 'delivered'; readonly at: number; readonly responseStatus?: number }
      | {
          readonly status: 'failed';
          readonly at: number;
          readonly errorCode: string;
          readonly retryable: boolean;
          readonly maxAttempts: number;
          readonly responseStatus?: number;
        },
  ): Promise<AlertDeliveryRecord>;
}

export interface AlertHealth {
  readonly transport: AlertTransportKind;
  readonly state: 'healthy' | 'retrying' | 'exhausted';
  readonly detail?: string;
}

function eventKind(effect: AlertEffect): GenericAlertPayload['eventKind'] {
  switch (effect.kind) {
    case 'initial':
      return 'new_activity';
    case 'reopen':
      return 'reopened_activity';
    case 'unacknowledged':
      return 'unacknowledged';
    case 'acknowledged':
      return 'pending_work';
  }
}

export function genericAlertPayload(
  effect: AlertEffect,
  item: QueueItem,
  evaluatedAt: number,
): GenericAlertPayload {
  return {
    schema: 'ackwatch.alert.v1',
    effectId: effect.id,
    eventKind: eventKind(effect),
    detectedAt: item.firstDetectedAt,
    evaluatedAt,
    ageMs: Math.max(0, evaluatedAt - item.firstDetectedAt),
    status: item.status,
    unseenCount: item.unseenActivityCount,
    escalationStage: effect.stage,
  };
}

export class AlertDispatcher {
  private running: Promise<void> | undefined;

  public constructor(
    private readonly repository: AlertRepositoryPort,
    private readonly clock: Clock,
    transports: readonly AlertTransport[],
    private readonly onHealth: (health: AlertHealth) => void = () => undefined,
  ) {
    this.transports = new Map(transports.map((transport) => [transport.kind, transport]));
  }

  private readonly transports: ReadonlyMap<AlertTransportKind, AlertTransport>;

  public dispatch(accountId: string): Promise<void> {
    this.running ??= this.run(accountId).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(accountId: string): Promise<void> {
    const now = this.clock.now();
    const settings = await this.repository.getSettings(accountId);
    const enabled: AlertTransportKind[] = [];
    if (settings.audioEnabled) enabled.push('audio');
    if (settings.browserNotificationsEnabled) enabled.push('browser_notification');
    if (settings.webhookEnabled) enabled.push('webhook');
    const ready = await this.repository.prepareDueAlertDeliveries(accountId, now, enabled);
    for (const candidate of ready) {
      const claimed = await this.repository.claimAlertDelivery(accountId, candidate.id, now);
      if (!claimed) continue;
      const transport = this.transports.get(claimed.transport);
      // Fetched by identity rather than scanned out of a full-account projection: the dispatcher
      // needs exactly one effect and one item per delivery.
      const [effect, item] = await Promise.all([
        this.repository.alertEffect(accountId, claimed.effectId),
        this.repository.queueItem(accountId, claimed.itemId),
      ]);
      if (!transport || !effect || !item) {
        await this.fail(accountId, claimed, settings, 'TRANSPORT_UNAVAILABLE', false);
        continue;
      }
      try {
        const result = await transport.send(genericAlertPayload(effect, item, now));
        await this.repository.settleAlertDelivery(accountId, claimed.id, {
          status: 'delivered',
          at: this.clock.now(),
          ...(result.responseStatus === undefined ? {} : { responseStatus: result.responseStatus }),
        });
        this.onHealth({ transport: claimed.transport, state: 'healthy' });
      } catch (error: unknown) {
        const failure =
          error instanceof AlertTransportError
            ? error
            : new AlertTransportError('UNEXPECTED_TRANSPORT_FAILURE', true);
        await this.fail(
          accountId,
          claimed,
          settings,
          failure.code,
          failure.retryable,
          failure.responseStatus,
        );
      }
    }
  }

  private async fail(
    accountId: string,
    delivery: AlertDeliveryRecord,
    settings: AccountSettingsRecord,
    errorCode: string,
    retryable: boolean,
    responseStatus?: number,
  ): Promise<void> {
    const maxAttempts = delivery.transport === 'webhook' ? settings.webhookMaxAttempts : 1;
    const settled = await this.repository.settleAlertDelivery(accountId, delivery.id, {
      status: 'failed',
      at: this.clock.now(),
      errorCode,
      retryable,
      maxAttempts,
      ...(responseStatus === undefined ? {} : { responseStatus }),
    });
    this.onHealth({
      transport: delivery.transport,
      state: settled.status === 'pending' ? 'retrying' : 'exhausted',
      detail: errorCode,
    });
  }
}

export interface SchedulerLifecycle {
  addEventListener(type: 'focus' | 'visibilitychange' | 'pageshow', listener: () => void): void;
  removeEventListener(type: 'focus' | 'visibilitychange' | 'pageshow', listener: () => void): void;
}

export class AlertScheduler {
  private interval: ReturnType<typeof setInterval> | undefined;
  private active = false;

  public constructor(
    private readonly evaluate: () => Promise<void>,
    private readonly lifecycle: SchedulerLifecycle,
    private readonly intervalMs = 15_000,
    private readonly setIntervalFn: (
      handler: () => void,
      timeout: number,
    ) => ReturnType<typeof setInterval> = (handler, timeout) => setInterval(handler, timeout),
    private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void = (handle) =>
      clearInterval(handle),
  ) {}

  public start(): void {
    if (this.active) return;
    this.active = true;
    this.lifecycle.addEventListener('focus', this.wake);
    this.lifecycle.addEventListener('visibilitychange', this.wake);
    this.lifecycle.addEventListener('pageshow', this.wake);
    this.interval = this.setIntervalFn(this.wake, this.intervalMs);
    this.wake();
  }

  public stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.interval !== undefined) this.clearIntervalFn(this.interval);
    this.interval = undefined;
    this.lifecycle.removeEventListener('focus', this.wake);
    this.lifecycle.removeEventListener('visibilitychange', this.wake);
    this.lifecycle.removeEventListener('pageshow', this.wake);
  }

  private readonly wake = (): void => {
    if (this.active) void this.evaluate();
  };
}
