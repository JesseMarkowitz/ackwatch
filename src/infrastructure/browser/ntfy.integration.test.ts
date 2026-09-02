/// <reference types="node" />
// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { GenericAlertPayload } from '../../application/alert-dispatcher';
import { defaultAccountSettings } from '../persistence/workflow-repository';
import { WebhookTransport } from './webhook-transport';

const ntfyUrl = process.env.ACKWATCH_NTFY_URL;
const run = ntfyUrl ? describe : describe.skip;

run('WebhookTransport self-hosted ntfy contract', () => {
  it('publishes the privacy-preserving preset to an isolated topic', async () => {
    const topic = `ackwatch-${Date.now().toString(36)}`;
    const accountId = '@monitor:example.test|https://matrix.example.test';
    const effectId = `synthetic-effect-${Date.now()}`;
    const payload: GenericAlertPayload = {
      schema: 'ackwatch.alert.v1',
      effectId,
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
    expect(notification).toMatchObject({
      topic,
      title: 'AckWatch attention required',
      message:
        'Matrix activity needs attention. Status ACKNOWLEDGED; escalation stage 1; age 30000 ms.',
    });
    expect(notification?.sequence_id).toBe(effectId);
    const serialized = JSON.stringify(notification);
    for (const forbidden of [accountId, 'room', 'sender', 'preview', 'mxc://']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
