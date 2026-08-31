export type DeliveryProvenance = 'live' | 'backfill' | 'gap_recovery' | 'cache';

export interface RawMatrixEvent {
  readonly eventId?: string;
  readonly roomId?: string;
  readonly sender?: string;
  readonly type?: string;
  readonly originServerTs?: number;
  readonly content?: Readonly<Record<string, unknown>>;
}

export interface IngestionEnvelope {
  readonly accountId: string;
  readonly event: RawMatrixEvent;
  readonly provenance: DeliveryProvenance;
  readonly localSequence: number;
  readonly detectedAt: number;
  readonly eligibleAtDelivery: boolean;
  readonly roomName?: string;
}

export type IgnoreReason =
  | 'monitoring_off'
  | 'backfill_not_recovery'
  | 'duplicate_event'
  | 'self_authored'
  | 'unsupported_event_type'
  | 'unsupported_message_type';

export interface SupportedActivity {
  readonly kind: 'activity';
  readonly accountId: string;
  readonly eventId: string;
  readonly roomId: string;
  readonly sender: string;
  readonly eventType: string;
  readonly messageType: 'm.text' | 'm.notice' | 'm.emote' | 'm.image' | 'm.file';
  readonly preview: string;
  readonly detectedAt: number;
  readonly localSequence: number;
  readonly provenance: DeliveryProvenance;
  readonly roomName?: string;
}

export interface IgnoredActivity {
  readonly kind: 'ignored';
  readonly reason: IgnoreReason;
  readonly eventId?: string;
}

export interface IngestionIssue {
  readonly kind: 'issue';
  readonly code: 'malformed_event' | 'encrypted_not_enabled' | 'processing_failure';
  readonly detail: string;
  readonly eventId?: string;
  readonly roomId?: string;
  readonly detectedAt: number;
}

export type NormalizationResult = SupportedActivity | IgnoredActivity | IngestionIssue;

export interface IngestionDecision {
  readonly eventId?: string;
  readonly outcome: 'accepted' | 'ignored' | 'issue';
  readonly reason: string;
}

const supportedMessageTypes = new Set<SupportedActivity['messageType']>([
  'm.text',
  'm.notice',
  'm.emote',
  'm.image',
  'm.file',
]);

function boundedPreview(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value).slice(0, 160).join('');
}

export function normalizeEnvelope(
  envelope: IngestionEnvelope,
  ownUserId: string,
): NormalizationResult {
  const { event } = envelope;

  if (!event.eventId || !event.roomId || !event.sender || !event.type) {
    return {
      kind: 'issue',
      code: 'malformed_event',
      detail: 'A Matrix event was missing an event ID, room ID, sender, or type.',
      ...(event.eventId === undefined ? {} : { eventId: event.eventId }),
      ...(event.roomId === undefined ? {} : { roomId: event.roomId }),
      detectedAt: envelope.detectedAt,
    };
  }

  if (envelope.provenance === 'backfill' || envelope.provenance === 'cache') {
    return { kind: 'ignored', reason: 'backfill_not_recovery', eventId: event.eventId };
  }

  if (!envelope.eligibleAtDelivery) {
    return { kind: 'ignored', reason: 'monitoring_off', eventId: event.eventId };
  }

  if (event.sender === ownUserId) {
    return { kind: 'ignored', reason: 'self_authored', eventId: event.eventId };
  }

  if (event.type === 'm.room.encrypted') {
    return {
      kind: 'issue',
      code: 'encrypted_not_enabled',
      detail: 'Encrypted activity is visible but deferred until the E2EE milestone.',
      eventId: event.eventId,
      roomId: event.roomId,
      detectedAt: envelope.detectedAt,
    };
  }

  if (event.type !== 'm.room.message') {
    return { kind: 'ignored', reason: 'unsupported_event_type', eventId: event.eventId };
  }

  const content = event.content ?? {};
  const messageType = content.msgtype;
  if (typeof messageType !== 'string' || !supportedMessageTypes.has(messageType as never)) {
    return { kind: 'ignored', reason: 'unsupported_message_type', eventId: event.eventId };
  }

  const preview =
    messageType === 'm.image' || messageType === 'm.file'
      ? boundedPreview(content.filename ?? content.body) || 'Attachment'
      : boundedPreview(content.body);

  return {
    kind: 'activity',
    accountId: envelope.accountId,
    eventId: event.eventId,
    roomId: event.roomId,
    sender: event.sender,
    eventType: event.type,
    messageType: messageType as SupportedActivity['messageType'],
    preview,
    detectedAt: envelope.detectedAt,
    localSequence: envelope.localSequence,
    provenance: envelope.provenance,
    ...(envelope.roomName === undefined ? {} : { roomName: envelope.roomName }),
  };
}

export class DeveloperLedger {
  private readonly eventIds = new Set<string>();
  private readonly activities: SupportedActivity[] = [];
  private readonly issues: IngestionIssue[] = [];
  private readonly ignoreCounts = new Map<IgnoreReason, number>();
  private readonly decisions: IngestionDecision[] = [];

  public record(result: NormalizationResult): boolean {
    if (result.kind === 'activity') {
      if (this.eventIds.has(result.eventId)) {
        this.ignoreCounts.set(
          'duplicate_event',
          (this.ignoreCounts.get('duplicate_event') ?? 0) + 1,
        );
        this.decisions.push({
          eventId: result.eventId,
          outcome: 'ignored',
          reason: 'duplicate_event',
        });
        return false;
      }
      this.eventIds.add(result.eventId);
      this.activities.push(result);
      this.decisions.push({ eventId: result.eventId, outcome: 'accepted', reason: 'activity' });
      return true;
    }
    if (result.kind === 'issue') {
      this.issues.push(result);
      this.decisions.push({
        ...(result.eventId === undefined ? {} : { eventId: result.eventId }),
        outcome: 'issue',
        reason: result.code,
      });
      return true;
    }
    this.ignoreCounts.set(result.reason, (this.ignoreCounts.get(result.reason) ?? 0) + 1);
    this.decisions.push({
      ...(result.eventId === undefined ? {} : { eventId: result.eventId }),
      outcome: 'ignored',
      reason: result.reason,
    });
    return false;
  }

  public recordFailure(issue: IngestionIssue): void {
    this.issues.push(issue);
    this.decisions.push({
      ...(issue.eventId === undefined ? {} : { eventId: issue.eventId }),
      outcome: 'issue',
      reason: issue.code,
    });
  }

  public snapshot(): {
    readonly activities: readonly SupportedActivity[];
    readonly issues: readonly IngestionIssue[];
    readonly ignoreCounts: Readonly<Record<IgnoreReason, number>>;
    readonly decisions: readonly IngestionDecision[];
  } {
    return {
      activities: [...this.activities],
      issues: [...this.issues],
      ignoreCounts: Object.fromEntries(this.ignoreCounts) as Readonly<Record<IgnoreReason, number>>,
      decisions: [...this.decisions],
    };
  }
}
