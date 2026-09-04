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
  /**
   * Short handle for the queue item, shown on its card so an alert can be matched to the work it
   * refers to. Safe to send: item ids are random UUIDs, carrying nothing about the room, sender,
   * or message (ALT-012).
   */
  readonly reference: string;
  readonly eventKind: 'new_activity' | 'reopened_activity' | 'unacknowledged' | 'pending_work';
  readonly detectedAt: number;
  /** When the newest activity on the item arrived, so an alert can say when rather than how long. */
  readonly lastActivityAt: number;
  readonly evaluatedAt: number;
  readonly ageMs: number;
  readonly status: QueueItem['status'];
  readonly unseenCount: number;
  readonly escalationStage: number;
  /** True only for the button in settings, so a test can never be mistaken for real work. */
  readonly test?: boolean;
}

/** The first segment of an item's UUID: short enough to read aloud, long enough to be unambiguous. */
export function itemReference(itemId: string): string {
  return itemId.slice(0, 8);
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
    /**
     * What the browser actually said, when the code is an interpretation rather than an
     * observation. `CONNECTION_OR_CORS_FAILURE` is a guess at why a `fetch` rejected, and a wrong
     * guess sends whoever reads it to the wrong place: an "Illegal invocation" TypeError was
     * reported as a CORS problem until someone probed the browser directly. Never contains a
     * destination, token, or message content — only the failure's own name and message.
     */
    public readonly underlying?: string,
  ) {
    super(underlying === undefined ? code : `${code}: ${underlying}`);
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

/** Rounded to the largest useful unit: an alert is read at a glance, not parsed. */
function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const eventKindLabels: Record<GenericAlertPayload['eventKind'], string> = {
  new_activity: 'New activity',
  reopened_activity: 'Reopened by new activity',
  unacknowledged: 'Still unacknowledged',
  pending_work: 'Acknowledged work still open',
};

/**
 * A line a person can act on, rather than the payload's raw fields.
 *
 * The previous text read "Status NEW; escalation stage 0; age 250 ms", which says nothing about
 * which item is involved and invites the reader to compare two numbers whose units and meaning are
 * not obvious — a first alert fires milliseconds after detection while an escalation fires long
 * after, so the same field can read 250 or 1_500_000 for reasons that are correct but unguessable.
 *
 * The reference matches the one printed on the item's card, which is what makes an alert findable.
 * Deliberately carries no room, sender, or message text (ALT-012).
 */
export function alertMessage(payload: GenericAlertPayload): string {
  if (payload.test) {
    return 'This is a test from AckWatch settings. No Matrix activity needs attention.';
  }
  const when = new Date(payload.lastActivityAt).toLocaleString();
  const parts = [
    `Item ${payload.reference}`,
    eventKindLabels[payload.eventKind],
    `last activity ${when}`,
    `waiting ${humanDuration(payload.ageMs)}`,
  ];
  if (payload.escalationStage > 0) {
    parts.push(`reminder ${payload.escalationStage}`);
  }
  if (payload.unseenCount > 0) {
    parts.push(`${payload.unseenCount} unseen`);
  }
  return `${parts.join(' · ')}.`;
}

export function genericAlertPayload(
  effect: AlertEffect,
  item: QueueItem,
  evaluatedAt: number,
): GenericAlertPayload {
  return {
    schema: 'ackwatch.alert.v1',
    effectId: effect.id,
    reference: itemReference(item.id),
    eventKind: eventKind(effect),
    detectedAt: item.firstDetectedAt,
    lastActivityAt: item.lastActivityAt,
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
