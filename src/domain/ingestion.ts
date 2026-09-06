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
  /**
   * Whether the room is a two-person conversation. Supplied by the runtime because room membership
   * is not on the event. A message in a room of two is addressed to the operator whether or not it
   * names them; a message in a busy room may be addressed to nobody in particular.
   */
  readonly directRoom?: boolean;
}

export type IgnoreReason =
  | 'monitoring_off'
  | 'backfill_not_recovery'
  | 'duplicate_event'
  | 'unsupported_event_type'
  | 'unsupported_message_type'
  | 'unsupported_relation';

export interface SupportedActivity {
  readonly kind: 'activity';
  readonly accountId: string;
  readonly eventId: string;
  readonly roomId: string;
  readonly sender: string;
  readonly eventType: string;
  readonly messageType:
    | 'm.text'
    | 'm.notice'
    | 'm.emote'
    | 'm.image'
    | 'm.file'
    | 'm.encrypted'
    | 'm.reaction'
    | 'm.sticker';
  readonly preview: string;
  readonly detectedAt: number;
  readonly localSequence: number;
  readonly provenance: DeliveryProvenance;
  readonly contentState: 'clear' | 'encrypted_placeholder' | 'unavailable';
  readonly decryptionFailureCode?: string;
  readonly media?: SafeMediaMetadata;
  readonly relationKind: 'independent' | 'thread' | 'reply' | 'reaction';
  readonly relationEventId?: string;
  readonly roomName?: string;
  /**
   * Whether this activity is work, or only the record of a conversation.
   *
   * `context_only` activity is stored and shown in an item's history and never does anything else:
   * it creates no item, reopens nothing, moves no deadline, and raises no alert. The operator's own
   * messages and their own reactions are the whole of it — being alerted about your own words is
   * absurd, but so is a history that shows one side of a conversation you took part in (EVT-011).
   */
  /**
   * Whether the room encrypted this event end to end.
   *
   * Taken from the wire type as well as the event type, because the client usually decrypts before
   * the timeline hands the event over — so by the time it is ingested it looks exactly like a
   * plaintext message, and once a placeholder is repaired it looks like one too. Without recording
   * it at intake the distinction is gone for good.
   */
  readonly encrypted: boolean;
  readonly attention: 'requires_attention' | 'context_only';
  /**
   * Whether the activity was addressed to the operator — it names them, or the room holds only the
   * two of them. It changes nothing about ordering or deadlines by decision; it is a label the
   * interface can show, so a direct request is recognisable among ambient traffic (EVT-012).
   */
  readonly addressing: 'direct' | 'ambient';
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

/** The bound ADR-0005 puts on stored plaintext, in characters rather than UTF-16 units. */
export const PREVIEW_CHARACTER_LIMIT = 160;

/**
 * An ellipsis is appended when, and only when, text was actually removed.
 *
 * Without it a cut-off preview is indistinguishable from a short message that happens to end
 * mid-sentence, so the display cannot tell the reader whether they are looking at the whole thing.
 * Marking it here rather than in the UI means every surface that renders a preview inherits the
 * signal, and it needs no schema change to carry a separate flag.
 */
function boundedPreview(value: unknown): string {
  if (typeof value !== 'string') return '';
  const characters = Array.from(value);
  if (characters.length <= PREVIEW_CHARACTER_LIMIT) return value;
  return `${characters.slice(0, PREVIEW_CHARACTER_LIMIT).join('')}…`;
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
      : relatesTo?.rel_type === 'm.annotation'
        ? 'reaction'
        : relationEventId === undefined
          ? 'independent'
          : 'reply';
  return { relationKind, ...(relationEventId === undefined ? {} : { relationEventId }) };
}

/**
 * Whether an event is addressed to the operator.
 *
 * `m.mentions` is the specified mechanism (Matrix 1.7) and is checked first. The body is checked
 * for the full user ID only — never a display name or localpart, which produce false positives on
 * ordinary words and would label ambient traffic as direct, which is worse than labelling nothing.
 */
function addressingOf(
  content: Readonly<Record<string, unknown>>,
  ownUserId: string,
  directRoom: boolean | undefined,
): SupportedActivity['addressing'] {
  if (directRoom === true) return 'direct';
  const mentions =
    content['m.mentions'] && typeof content['m.mentions'] === 'object'
      ? (content['m.mentions'] as Readonly<Record<string, unknown>>)
      : undefined;
  const mentioned = Array.isArray(mentions?.user_ids)
    ? mentions.user_ids.some((id) => id === ownUserId)
    : false;
  if (mentioned) return 'direct';
  const body = typeof content.body === 'string' ? content.body : '';
  return body.includes(ownUserId) ? 'direct' : 'ambient';
}

function reactionPreview(key: unknown): string {
  const symbol = typeof key === 'string' && key.trim() ? key.trim() : 'a reaction';
  return boundedPreview(`Reacted ${symbol}`);
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

  // Self-authored activity is retained rather than dropped. Being alerted about your own words is
  // absurd, but a history showing one side of a conversation you took part in is a worse record
  // (EVT-011), so it flows on as `context_only` and is filtered by disposition, not by discarding.
  const attention: SupportedActivity['attention'] =
    event.sender === ownUserId ? 'context_only' : 'requires_attention';
  const encrypted = event.type === 'm.room.encrypted' || event.wireType === 'm.room.encrypted';
  const addressing = addressingOf(content, ownUserId, envelope.directRoom);

  // A reaction is an annotation on another event. Someone else reacting to a message — including
  // to one of yours, which is the case that prompted this — is a response that needs attention;
  // your own reaction is only part of the record (EVT-009, amended).
  if (event.type === 'm.reaction') {
    if (relatesTo?.rel_type !== 'm.annotation' || typeof relatesTo.event_id !== 'string') {
      return { kind: 'ignored', reason: 'unsupported_relation', eventId: event.eventId };
    }
    return {
      kind: 'activity',
      accountId: envelope.accountId,
      eventId: event.eventId,
      roomId: event.roomId,
      sender: event.sender,
      eventType: 'm.reaction',
      messageType: 'm.reaction',
      preview: reactionPreview(relatesTo.key),
      detectedAt: envelope.detectedAt,
      localSequence: envelope.localSequence,
      provenance: envelope.provenance,
      contentState: 'clear',
      relationKind: 'reaction',
      relationEventId: relatesTo.event_id,
      encrypted,
      attention,
      addressing,
      ...(envelope.roomName === undefined ? {} : { roomName: envelope.roomName }),
    };
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
      encrypted,
      attention,
      addressing,
      ...(envelope.roomName === undefined ? {} : { roomName: envelope.roomName }),
    };
  }

  // A sticker is a picture posted as its own event type rather than as a message, so it carries no
  // msgtype and would otherwise be dismissed as an unsupported event. It is a post like any other.
  if (event.type === 'm.sticker') {
    const stickerName = boundedPreview(content.body);
    return {
      kind: 'activity',
      accountId: envelope.accountId,
      eventId: event.eventId,
      roomId: event.roomId,
      sender: event.sender,
      eventType: 'm.sticker',
      messageType: 'm.sticker',
      preview: stickerName ? `Sticker: ${stickerName}` : 'Sticker',
      detectedAt: envelope.detectedAt,
      localSequence: envelope.localSequence,
      provenance: envelope.provenance,
      contentState: 'clear',
      ...relationOf(relatesTo),
      encrypted,
      attention,
      addressing,
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

  // A picture posted with no words has a body that is a filename, or nothing at all, and either
  // read on a card as though it were the message. The preview says what arrived first, so a post
  // that is only an image is recognisable as one without opening it.
  const attachmentName = boundedPreview(content.filename ?? content.body);
  const preview =
    messageType === 'm.image'
      ? attachmentName
        ? `Picture: ${attachmentName}`
        : 'Picture'
      : messageType === 'm.file'
        ? attachmentName
          ? `File: ${attachmentName}`
          : 'File'
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
    encrypted,
    attention,
    addressing,
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
