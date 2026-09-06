import { describe, expect, it } from 'vitest';

import type { Clock } from './clock';
import { CoverageMachine } from './coverage';
import { DeveloperLedger, type IngestionEnvelope, normalizeEnvelope } from './ingestion';
import { SerialIngestion } from '../application/serial-ingestion';

function envelope(overrides: Partial<IngestionEnvelope> = {}): IngestionEnvelope {
  return {
    accountId: '@monitor:example.test|https://example.test',
    event: {
      eventId: '$event',
      roomId: '!room:example.test',
      sender: '@sender:example.test',
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'Needs attention' },
    },
    provenance: 'live',
    localSequence: 1,
    detectedAt: 1_000,
    eligibleAtDelivery: true,
    ...overrides,
  };
}

describe('normalization', () => {
  it.each([
    ['m.text', 'hello', 'hello'],
    ['m.notice', 'notice', 'notice'],
    ['m.emote', 'waves', 'waves'],
    // An attachment's body is its filename, not a message, so the preview says what arrived.
    ['m.image', 'image.png', 'Picture: image.png'],
    ['m.file', 'report.pdf', 'File: report.pdf'],
  ] as const)('accepts supported %s messages', (msgtype, body, preview) => {
    const result = normalizeEnvelope(
      envelope({ event: { ...envelope().event, content: { msgtype, body } } }),
      '@monitor:example.test',
    );

    expect(result).toMatchObject({ kind: 'activity', messageType: msgtype, preview });
  });

  /*
   * Reported from real use: a picture posted with no words did not read as a picture. A client may
   * send an image with its filename as the body, with an empty body, or with no body at all, and
   * the first of those rendered as though the filename were the message while the others said
   * nothing. All three now name what arrived, and none of them is ignored.
   */
  it.each([
    [{ msgtype: 'm.image', body: 'holiday.jpg' }, 'Picture: holiday.jpg'],
    [{ msgtype: 'm.image', body: '' }, 'Picture'],
    [{ msgtype: 'm.image' }, 'Picture'],
    [{ msgtype: 'm.image', filename: 'scan.png', body: 'scan.png' }, 'Picture: scan.png'],
  ])('describes a picture posted without words (%#)', (content, preview) => {
    expect(
      normalizeEnvelope(
        envelope({ event: { ...envelope().event, content } }),
        '@monitor:example.test',
      ),
    ).toMatchObject({
      kind: 'activity',
      messageType: 'm.image',
      attention: 'requires_attention',
      preview,
    });
  });

  /*
   * The client normally decrypts before the timeline hands an event over, so by the time it is
   * ingested an encrypted message looks exactly like a plaintext one — and once a placeholder is
   * repaired it looks like one too. The wire type is the only thing that still remembers.
   */
  it('records that a room encrypted a message, however it arrived', () => {
    const decryptedOnArrival = normalizeEnvelope(
      envelope({
        event: {
          ...envelope().event,
          type: 'm.room.message',
          wireType: 'm.room.encrypted',
          content: { msgtype: 'm.text', body: 'clear by the time we saw it' },
        },
      }),
      '@monitor:example.test',
    );
    expect(decryptedOnArrival).toMatchObject({ kind: 'activity', encrypted: true });

    const stillEncrypted = normalizeEnvelope(
      envelope({ event: { ...envelope().event, type: 'm.room.encrypted', content: {} } }),
      '@monitor:example.test',
    );
    expect(stillEncrypted).toMatchObject({ kind: 'activity', encrypted: true });

    expect(normalizeEnvelope(envelope(), '@monitor:example.test')).toMatchObject({
      kind: 'activity',
      encrypted: false,
    });
  });

  it('treats a sticker as the picture it is rather than an unsupported event', () => {
    // Stickers are their own event type and carry no msgtype, so the message-type gate never saw
    // them and they were dismissed as unsupported — a picture posted, and nothing said about it.
    expect(
      normalizeEnvelope(
        envelope({
          event: {
            ...envelope().event,
            type: 'm.sticker',
            content: { body: 'thumbsup', url: 'mxc://example.test/sticker' },
          },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({
      kind: 'activity',
      messageType: 'm.sticker',
      preview: 'Sticker: thumbsup',
      attention: 'requires_attention',
    });
  });

  it('rejects cache/backfill and stopped-window activity intentionally', () => {
    expect(
      normalizeEnvelope(envelope({ provenance: 'backfill' }), '@monitor:example.test'),
    ).toMatchObject({ kind: 'ignored', reason: 'backfill_not_recovery' });
    expect(
      normalizeEnvelope(envelope({ eligibleAtDelivery: false }), '@monitor:example.test'),
    ).toMatchObject({ kind: 'ignored', reason: 'monitoring_off' });
  });

  /*
   * EVT-011, amended 2026-09-05. Self-authored activity used to be dropped here, which was right
   * about alerting and wrong about the record: an item's history showed one side of a conversation
   * the operator had taken part in. It is retained and marked instead, and everything downstream
   * filters on the mark.
   */
  it('keeps the operator\u2019s own message as context rather than dropping it', () => {
    expect(
      normalizeEnvelope(
        envelope({ event: { ...envelope().event, sender: '@monitor:example.test' } }),
        '@monitor:example.test',
      ),
    ).toMatchObject({ kind: 'activity', attention: 'context_only' });
  });

  it('marks a message that names the operator, or arrives in a room of two, as direct', () => {
    const ambient = normalizeEnvelope(envelope(), '@monitor:example.test');
    expect(ambient).toMatchObject({ addressing: 'ambient' });

    const mentioned = normalizeEnvelope(
      envelope({
        event: {
          ...envelope().event,
          content: {
            msgtype: 'm.text',
            body: 'can you look at this',
            'm.mentions': { user_ids: ['@monitor:example.test'] },
          },
        },
      }),
      '@monitor:example.test',
    );
    expect(mentioned).toMatchObject({ addressing: 'direct' });

    expect(
      normalizeEnvelope(envelope({ directRoom: true }), '@monitor:example.test'),
    ).toMatchObject({ addressing: 'direct' });
  });

  /*
   * EVT-009, amended 2026-09-05. Reactions were an explicit non-goal, on the reasoning that a
   * reaction is not work. A reaction from someone else is a response — frequently the only response
   * a message gets — and the case that prompted the change is a reaction to the operator's own
   * message, which is why retaining self-authored activity had to come first.
   */
  it('treats another person\u2019s reaction as work and the operator\u2019s own as context', () => {
    const reaction = (sender: string) =>
      normalizeEnvelope(
        envelope({
          event: {
            ...envelope().event,
            eventId: `$reaction-${sender}`,
            sender,
            type: 'm.reaction',
            content: {
              'm.relates_to': { rel_type: 'm.annotation', event_id: '$target', key: '\u{1F44D}' },
            },
          },
        }),
        '@monitor:example.test',
      );

    expect(reaction('@other:example.test')).toMatchObject({
      kind: 'activity',
      messageType: 'm.reaction',
      relationKind: 'reaction',
      relationEventId: '$target',
      attention: 'requires_attention',
    });
    expect(reaction('@monitor:example.test')).toMatchObject({
      kind: 'activity',
      attention: 'context_only',
    });
  });

  it('ignores a reaction that annotates nothing', () => {
    expect(
      normalizeEnvelope(
        envelope({
          event: { ...envelope().event, type: 'm.reaction', content: { 'm.relates_to': {} } },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({ kind: 'ignored', reason: 'unsupported_relation' });
  });

  it('uses Unicode code points for the bounded preview', () => {
    const body = '😀'.repeat(170);
    const result = normalizeEnvelope(
      envelope({ event: { ...envelope().event, content: { msgtype: 'm.text', body } } }),
      '@monitor:example.test',
    );

    expect(result.kind).toBe('activity');
    if (result.kind === 'activity') {
      // 160 code points of content plus the marker that says content was removed. Counting code
      // points rather than UTF-16 units is the point: 160 emoji are 320 units.
      expect(Array.from(result.preview)).toHaveLength(161);
      expect(result.preview.endsWith('…')).toBe(true);
      expect(Array.from(result.preview.slice(0, -1))).toHaveLength(160);
    }
  });

  it('leaves a message that fits the bound unmarked', () => {
    const body = 'Short enough to keep whole.';
    const result = normalizeEnvelope(
      envelope({ event: { ...envelope().event, content: { msgtype: 'm.text', body } } }),
      '@monitor:example.test',
    );

    expect(result.kind).toBe('activity');
    // A reader must be able to tell a bounded preview from a complete message, so the marker
    // appears only when text was actually dropped.
    if (result.kind === 'activity') expect(result.preview).toBe(body);
  });

  it('turns malformed events into issues and encrypted events into durable placeholders', () => {
    expect(
      normalizeEnvelope(envelope({ event: { type: 'm.room.message' } }), '@monitor:example.test'),
    ).toMatchObject({ kind: 'issue', code: 'malformed_event' });
    expect(
      normalizeEnvelope(
        envelope({ event: { ...envelope().event, type: 'm.room.encrypted' } }),
        '@monitor:example.test',
      ),
    ).toMatchObject({
      kind: 'activity',
      messageType: 'm.encrypted',
      contentState: 'encrypted_placeholder',
    });
  });

  it('records stable decryption failure reasons and late successful enrichment as maintenance', () => {
    expect(
      normalizeEnvelope(
        envelope({
          event: {
            ...envelope().event,
            type: 'm.room.encrypted',
            decryptionFailureCode: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID',
          },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({
      kind: 'activity',
      contentState: 'unavailable',
      decryptionFailureCode: 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID',
    });
    expect(
      normalizeEnvelope(
        envelope({
          eligibleAtDelivery: false,
          event: {
            ...envelope().event,
            wireType: 'm.room.encrypted',
            decryptionUpdate: 'success',
            content: { msgtype: 'm.text', body: 'Decrypted later' },
          },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({
      kind: 'maintenance',
      mutation: 'decryption_success',
      preview: 'Decrypted later',
    });
  });

  it('extracts bounded safe image/file metadata without attachment bytes', () => {
    const result = normalizeEnvelope(
      envelope({
        event: {
          ...envelope().event,
          content: {
            msgtype: 'm.image',
            body: 'diagram.png',
            url: 'mxc://example.test/secret',
            info: { mimetype: 'image/png', size: 42, w: 640, h: 480 },
          },
        },
      }),
      '@monitor:example.test',
    );

    expect(result).toMatchObject({
      kind: 'activity',
      media: { name: 'diagram.png', mimeType: 'image/png', size: 42, width: 640, height: 480 },
    });
    expect(JSON.stringify(result)).not.toContain('mxc://');
  });

  it('classifies stable threads separately from ordinary replies', () => {
    expect(
      normalizeEnvelope(
        envelope({
          event: {
            ...envelope().event,
            content: {
              msgtype: 'm.text',
              body: 'thread reply',
              'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
            },
          },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({ kind: 'activity', relationKind: 'thread', relationEventId: '$root' });
    expect(
      normalizeEnvelope(
        envelope({
          event: {
            ...envelope().event,
            content: {
              msgtype: 'm.text',
              body: 'ordinary reply',
              'm.relates_to': { 'm.in_reply_to': { event_id: '$parent' } },
            },
          },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({ kind: 'activity', relationKind: 'reply', relationEventId: '$parent' });
  });

  it('classifies encrypted relations from cleartext wire content', () => {
    const encryptedEvent = (relatesTo: Record<string, unknown>) => ({
      ...envelope().event,
      type: 'm.room.encrypted',
      content: {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: 'AwgAEn…',
        'm.relates_to': relatesTo,
      },
    });

    expect(
      normalizeEnvelope(
        envelope({ event: encryptedEvent({ rel_type: 'm.thread', event_id: '$root' }) }),
        '@monitor:example.test',
      ),
    ).toMatchObject({
      kind: 'activity',
      contentState: 'encrypted_placeholder',
      relationKind: 'thread',
      relationEventId: '$root',
    });
    expect(
      normalizeEnvelope(
        envelope({ event: encryptedEvent({ 'm.in_reply_to': { event_id: '$parent' } }) }),
        '@monitor:example.test',
      ),
    ).toMatchObject({ kind: 'activity', relationKind: 'reply', relationEventId: '$parent' });
    expect(
      normalizeEnvelope(
        envelope({
          event: {
            ...envelope().event,
            type: 'm.room.encrypted',
            content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'AwgAEn…' },
          },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({ kind: 'activity', relationKind: 'independent' });
  });

  it('treats an encrypted replacement as maintenance that cannot blank the preview', () => {
    expect(
      normalizeEnvelope(
        envelope({
          event: {
            ...envelope().event,
            type: 'm.room.encrypted',
            content: {
              algorithm: 'm.megolm.v1.aes-sha2',
              ciphertext: 'AwgAEn…',
              'm.relates_to': { rel_type: 'm.replace', event_id: '$original' },
            },
          },
        }),
        '@monitor:example.test',
      ),
    ).toEqual({
      kind: 'maintenance',
      mutation: 'edit',
      accountId: envelope().accountId,
      targetEventId: '$original',
      roomId: '!room:example.test',
      detectedAt: 1_000,
    });
  });

  it('routes a decrypted replacement to its target instead of enriching the edit event', () => {
    expect(
      normalizeEnvelope(
        envelope({
          event: {
            ...envelope().event,
            wireType: 'm.room.encrypted',
            decryptionUpdate: 'success',
            content: {
              msgtype: 'm.text',
              body: '* corrected text',
              'm.relates_to': { rel_type: 'm.replace', event_id: '$original' },
              'm.new_content': { msgtype: 'm.text', body: 'corrected text' },
            },
          },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({
      kind: 'maintenance',
      mutation: 'edit',
      targetEventId: '$original',
      preview: 'corrected text',
    });
  });

  it('accepts edits and redactions as maintenance while monitoring is off', () => {
    expect(
      normalizeEnvelope(
        envelope({
          eligibleAtDelivery: false,
          event: {
            ...envelope().event,
            eventId: '$edit',
            content: {
              msgtype: 'm.text',
              body: '* edited',
              'm.new_content': { msgtype: 'm.text', body: 'edited' },
              'm.relates_to': { rel_type: 'm.replace', event_id: '$event' },
            },
          },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({ kind: 'maintenance', mutation: 'edit', targetEventId: '$event' });
    expect(
      normalizeEnvelope(
        envelope({
          eligibleAtDelivery: false,
          event: {
            ...envelope().event,
            eventId: '$redaction',
            type: 'm.room.redaction',
            redacts: '$event',
          },
        }),
        '@monitor:example.test',
      ),
    ).toMatchObject({ kind: 'maintenance', mutation: 'redaction', targetEventId: '$event' });
  });
});

describe('SerialIngestion', () => {
  it('processes in sequence and deduplicates event IDs without throwing into callbacks', async () => {
    const clock: Clock = { now: () => 1_000 };
    const coverage = new CoverageMachine(clock);
    coverage.beginStartup();
    coverage.observeSync({ state: 'syncing' });
    coverage.startMonitoring();
    const ledger = new DeveloperLedger();
    const pipeline = new SerialIngestion(
      '@monitor:example.test',
      coverage,
      ledger,
      () => undefined,
    );

    expect(() => {
      pipeline.enqueue(envelope());
      pipeline.enqueue(envelope({ localSequence: 2 }));
      pipeline.enqueue(
        envelope({
          localSequence: 3,
          event: {
            ...envelope().event,
            eventId: '$second',
            content: { msgtype: 'm.text', body: '2' },
          },
        }),
      );
    }).not.toThrow();

    await pipeline.idle();

    expect(ledger.snapshot().activities.map(({ eventId }) => eventId)).toEqual([
      '$event',
      '$second',
    ]);
    expect(coverage.snapshot()).toMatchObject({ connection: 'ready', ingestionPending: 0 });
  });

  it('contains a processing exception at the asynchronous callback boundary', async () => {
    class ExplodingLedger extends DeveloperLedger {
      public override record(): boolean {
        throw new Error('injected normalizer boundary failure');
      }
    }
    const coverage = new CoverageMachine({ now: () => 1_000 });
    coverage.beginStartup();
    coverage.observeSync({ state: 'syncing' });
    coverage.startMonitoring();
    const ledger = new ExplodingLedger();
    const pipeline = new SerialIngestion(
      '@monitor:example.test',
      coverage,
      ledger,
      () => undefined,
    );

    expect(() => pipeline.enqueue(envelope())).not.toThrow();
    await expect(pipeline.idle()).resolves.toBeUndefined();
    expect(ledger.snapshot().issues).toEqual([
      expect.objectContaining({ code: 'processing_failure', eventId: '$event' }),
    ]);
    expect(coverage.snapshot()).toMatchObject({ connection: 'ready', ingestionPending: 0 });
  });
});
