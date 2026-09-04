/// <reference types="node" />
// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { GenericAlertPayload } from '../../application/alert-dispatcher';
import { alertEffectId } from '../../domain/queue';
import { defaultAccountSettings } from '../persistence/workflow-repository';
import { WebhookTransport } from './webhook-transport';

const ntfyUrl = process.env.ACKWATCH_NTFY_URL;
const run = ntfyUrl ? describe : describe.skip;

run('WebhookTransport self-hosted ntfy contract', () => {
  it('publishes the privacy-preserving preset to an isolated topic', async () => {
    const topic = `ackwatch-${Date.now().toString(36)}`;
    const accountId = '@monitor:example.test|https://matrix.example.test';
    // A real effect id, built the way the application builds one. The fixture used to be
    // `synthetic-effect-<millis>`, which ntfy happily accepts — so this test passed while every
    // real alert was rejected with "sequence ID invalid", because a genuine effect id is
    // `itemId|cycleId|kind|stage` and the pipes are not valid in the field it was being sent in.
    // A fixture shaped unlike the production value tests a path the product never takes.
    const effectId = alertEffectId(`item-${Date.now().toString(36)}`, 'cycle-1', 'reopen', 1);
    const payload: GenericAlertPayload = {
      schema: 'ackwatch.alert.v1',
      effectId,
      reference: 'ref12345',
      lastActivityAt: 1_000,
      eventKind: 'pending_work',
      detectedAt: 1_000,
      evaluatedAt: 31_000,
      ageMs: 30_000,
      status: 'ACKNOWLEDGED',
      unseenCount: 0,
      escalationStage: 1,
    };
    const settings = {
      ...defaultAccountSettings(accountId, 1_000),
      webhookEnabled: true,
      webhookPreset: 'ntfy' as const,
      webhookEndpoint: ntfyUrl ?? '',
      webhookTopic: topic,
    };
    const credentials = { read: () => undefined, write() {}, clear() {} };
    const transport = new WebhookTransport(accountId, () => settings, credentials);

    await expect(transport.send(payload)).resolves.toMatchObject({ responseStatus: 200 });
    const response = await fetch(`${ntfyUrl}/${topic}/json?poll=1`);
    expect(response.ok).toBe(true);
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const notification = events.find(({ event }) => event === 'message');
    expect(notification).toMatchObject({ topic, title: 'AckWatch: attention required' });
    // Asserted by parts rather than as one string: the message embeds a local timestamp, so an
    // exact match would pass or fail on the runner's time zone rather than on the behaviour.
    const message = String(notification?.message);
    expect(message).toContain('ref12345');
    expect(message).toContain('Acknowledged work still open');
    expect(message).toContain('reminder 1');
    // The effect id is not sent to ntfy at all: `sequence_id` is ntfy's handle for editing a
    // notification it already holds, and AckWatch never edits one. Idempotency is carried in the
    // `Idempotency-Key` header instead.
    expect(notification).not.toHaveProperty('sequence_id');
    expect(JSON.stringify(notification)).not.toContain(effectId);
    const serialized = JSON.stringify(notification);
    for (const forbidden of [accountId, 'room', 'sender', 'preview', 'mxc://']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
