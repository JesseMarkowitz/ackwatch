export type DeliveryProvenance = 'live' | 'backfill' | 'gap_recovery' | 'cache';

export interface RawMatrixEvent {
  readonly eventId?: string;
  readonly roomId?: string;
  readonly sender?: string;
  readonly type?: string;
  readonly originServerTs?: number;
  readonly content?: Readonly<Record<string, unknown>>;
  readonly redacts?: string;
  readonly wireType?: string;
  readonly decryptionUpdate?: 'success' | 'failure';
  readonly decryptionFailureCode?: string;
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
  readonly messageType: 'm.text' | 'm.notice' | 'm.emote' | 'm.image' | 'm.file' | 'm.encrypted';
  readonly preview: string;
  readonly detectedAt: number;
  readonly localSequence: number;
  readonly provenance: DeliveryProvenance;
  readonly contentState: 'clear' | 'encrypted_placeholder' | 'unavailable';
  readonly decryptionFailureCode?: string;
  readonly media?: SafeMediaMetadata;
  readonly relationKind: 'independent' | 'thread' | 'reply';
  readonly relationEventId?: string;
  readonly roomName?: string;
}

export interface MaintenanceMutation {
  readonly kind: 'maintenance';
  readonly mutation: 'edit' | 'redaction' | 'decryption_success' | 'decryption_failure';
  readonly accountId: string;
  readonly targetEventId: string;
  readonly roomId: string;
  readonly detectedAt: number;
  readonly preview?: string;
  readonly messageType?: SupportedActivity['messageType'];
  readonly decryptionFailureCode?: string;
  readonly media?: SafeMediaMetadata;
}

export interface IgnoredActivity {
  readonly kind: 'ignored';
  readonly reason: IgnoreReason;
  readonly eventId?: string;
}

export interface IngestionIssue {
  readonly kind: 'issue';
  readonly code: 'malformed_event' | 'decryption_failure' | 'processing_failure';
  readonly detail: string;
  readonly eventId?: string;
  readonly roomId?: string;
  readonly detectedAt: number;
}

export type NormalizationResult =
  SupportedActivity | MaintenanceMutation | IgnoredActivity | IngestionIssue;

export interface IngestionDecision {
  readonly eventId?: string;
  readonly outcome: 'accepted' | 'maintenance' | 'ignored' | 'issue';
  readonly reason: string;
}

const supportedMessageTypes = new Set<SupportedActivity['messageType']>([
  'm.text',
  'm.notice',
  'm.emote',
  'm.image',
  'm.file',
]);

export interface SafeMediaMetadata {
  readonly name: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly width?: number;
  readonly height?: number;
}

function boundedPreview(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value).slice(0, 160).join('');
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function mediaMetadata(content: Readonly<Record<string, unknown>>): SafeMediaMetadata | undefined {
  if (content.msgtype !== 'm.image' && content.msgtype !== 'm.file') return undefined;
  const info =
    content.info && typeof content.info === 'object'
      ? (content.info as Readonly<Record<string, unknown>>)
      : {};
  const name = boundedPreview(content.filename ?? content.body) || 'Attachment';
  const mimeType = typeof info.mimetype === 'string' ? boundedPreview(info.mimetype) : undefined;
  const size = safeNonnegativeInteger(info.size);
  const width = safeNonnegativeInteger(info.w);
  const height = safeNonnegativeInteger(info.h);
  return {
    name,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(size === undefined ? {} : { size }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

function relationOf(relatesTo: Readonly<Record<string, unknown>> | undefined): {
  readonly relationKind: SupportedActivity['relationKind'];
  readonly relationEventId?: string;
} {
  const replyMetadata =
    relatesTo?.['m.in_reply_to'] && typeof relatesTo['m.in_reply_to'] === 'object'
      ? (relatesTo['m.in_reply_to'] as Readonly<Record<string, unknown>>)
      : undefined;
  const relationEventId =
    typeof relatesTo?.event_id === 'string'
      ? relatesTo.event_id
      : typeof replyMetadata?.event_id === 'string'
        ? replyMetadata.event_id
        : undefined;
  const relationKind =
    relatesTo?.rel_type === 'm.thread'
      ? 'thread'
      : relationEventId === undefined
        ? 'independent'
        : 'reply';
  return { relationKind, ...(relationEventId === undefined ? {} : { relationEventId }) };
}

function editPreview(content: Readonly<Record<string, unknown>>): string {
  const newContent =
    content['m.new_content'] && typeof content['m.new_content'] === 'object'
      ? (content['m.new_content'] as Readonly<Record<string, unknown>>)
      : undefined;
  return boundedPreview(newContent?.body ?? content.body);
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

  const content = event.content ?? {};
  const relatesTo =
    content['m.relates_to'] && typeof content['m.relates_to'] === 'object'
      ? (content['m.relates_to'] as Readonly<Record<string, unknown>>)
      : undefined;
  if (event.decryptionUpdate === 'failure') {
    return {
      kind: 'maintenance',
      mutation: 'decryption_failure',
      accountId: envelope.accountId,
      targetEventId: event.eventId,
      roomId: event.roomId,
      detectedAt: envelope.detectedAt,
      decryptionFailureCode: event.decryptionFailureCode ?? 'UNKNOWN_ERROR',
    };
  }
  if (event.decryptionUpdate === 'success') {
    const messageType = content.msgtype;
    if (event.type !== 'm.room.message' || typeof messageType !== 'string') {
      return {
        kind: 'issue',
        code: 'decryption_failure',
        detail: 'Decryption produced an unsupported or malformed clear event.',
        eventId: event.eventId,
        roomId: event.roomId,
        detectedAt: envelope.detectedAt,
      };
    }
    if (relatesTo?.rel_type === 'm.replace' && typeof relatesTo.event_id === 'string') {
      return {
        kind: 'maintenance',
        mutation: 'edit',
        accountId: envelope.accountId,
        targetEventId: relatesTo.event_id,
        roomId: event.roomId,
        detectedAt: envelope.detectedAt,
        preview: editPreview(content),
      };
    }
    const media = mediaMetadata(content);
    return {
      kind: 'maintenance',
      mutation: 'decryption_success',
      accountId: envelope.accountId,
      targetEventId: event.eventId,
      roomId: event.roomId,
      detectedAt: envelope.detectedAt,
      preview:
        messageType === 'm.image' || messageType === 'm.file'
          ? boundedPreview(content.filename ?? content.body) || 'Attachment'
          : boundedPreview(content.body),
      messageType: supportedMessageTypes.has(messageType as SupportedActivity['messageType'])
        ? (messageType as SupportedActivity['messageType'])
        : 'm.encrypted',
      ...(media === undefined ? {} : { media }),
    };
  }
  if (event.type === 'm.room.redaction' && event.redacts) {
    return {
      kind: 'maintenance',
      mutation: 'redaction',
      accountId: envelope.accountId,
      targetEventId: event.redacts,
      roomId: event.roomId,
      detectedAt: envelope.detectedAt,
    };
  }
  if (
    (event.type === 'm.room.message' || event.type === 'm.room.encrypted') &&
    relatesTo?.rel_type === 'm.replace' &&
    typeof relatesTo.event_id === 'string'
  ) {
    return {
      kind: 'maintenance',
      mutation: 'edit',
      accountId: envelope.accountId,
      targetEventId: relatesTo.event_id,
      roomId: event.roomId,
      detectedAt: envelope.detectedAt,
      // An encrypted replacement carries no readable body until its own decryption
      // arrives; marking the target edited must not blank the preview meanwhile.
      ...(event.type === 'm.room.encrypted' ? {} : { preview: editPreview(content) }),
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
    const failed = event.decryptionFailureCode !== undefined;
    // Relation information is lifted out of the ciphertext into the cleartext wire
    // content, so an encrypted thread reply groups by root from its placeholder on.
    const relation = relationOf(relatesTo);
    return {
      kind: 'activity',
      accountId: envelope.accountId,
      eventId: event.eventId,
      roomId: event.roomId,
      sender: event.sender,
      eventType: 'm.room.encrypted',
      messageType: 'm.encrypted',
      preview: failed ? 'Encrypted message unavailable' : 'Encrypted message—waiting for keys',
      detectedAt: envelope.detectedAt,
      localSequence: envelope.localSequence,
      provenance: envelope.provenance,
      contentState: failed ? 'unavailable' : 'encrypted_placeholder',
      ...(failed ? { decryptionFailureCode: event.decryptionFailureCode } : {}),
      ...relation,
      ...(envelope.roomName === undefined ? {} : { roomName: envelope.roomName }),
    };
  }

  if (event.type !== 'm.room.message') {
    return { kind: 'ignored', reason: 'unsupported_event_type', eventId: event.eventId };
  }

  const messageType = content.msgtype;
  if (typeof messageType !== 'string' || !supportedMessageTypes.has(messageType as never)) {
    return { kind: 'ignored', reason: 'unsupported_message_type', eventId: event.eventId };
  }

  const preview =
    messageType === 'm.image' || messageType === 'm.file'
      ? boundedPreview(content.filename ?? content.body) || 'Attachment'
      : boundedPreview(content.body);
  const media = mediaMetadata(content);
  const relation = relationOf(relatesTo);

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
    contentState: 'clear',
    ...(media === undefined ? {} : { media }),
    ...relation,
    ...(envelope.roomName === undefined ? {} : { roomName: envelope.roomName }),
  };
}

export class DeveloperLedger {
  private readonly eventIds = new Set<string>();
  private readonly activities: SupportedActivity[] = [];
  private readonly mutations: MaintenanceMutation[] = [];
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
    if (result.kind === 'maintenance') {
      this.mutations.push(result);
      this.decisions.push({
        eventId: result.targetEventId,
        outcome: 'maintenance',
        reason: result.mutation,
      });
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
    readonly mutations: readonly MaintenanceMutation[];
    readonly issues: readonly IngestionIssue[];
    readonly ignoreCounts: Readonly<Record<IgnoreReason, number>>;
    readonly decisions: readonly IngestionDecision[];
  } {
    return {
      activities: [...this.activities],
      mutations: [...this.mutations],
      issues: [...this.issues],
      ignoreCounts: Object.fromEntries(this.ignoreCounts) as Readonly<Record<IgnoreReason, number>>,
      decisions: [...this.decisions],
    };
  }
}
