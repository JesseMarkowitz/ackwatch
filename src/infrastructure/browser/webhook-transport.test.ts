import { describe, expect, it } from 'vitest';

import type { GenericAlertPayload } from '../../application/alert-dispatcher';
import { defaultAccountSettings } from '../persistence/workflow-repository';
import { WebhookCredentialStore } from './webhook-credential-store';
import { WebhookTransport, webhookDestination } from './webhook-transport';

const accountId = '@monitor:example.test|https://example.test';
const payload: GenericAlertPayload = {
  schema: 'ackwatch.alert.v1',
  effectId: 'effect-id',
  reference: 'ref12345',
  lastActivityAt: 1_000,
  eventKind: 'new_activity',
  detectedAt: 1_000,
  evaluatedAt: 2_000,
  ageMs: 1_000,
  status: 'NEW',
  unseenCount: 1,
  escalationStage: 0,
};

describe('WebhookTransport', () => {
  it('requires HTTPS except loopback and rejects URL credentials/query strings', () => {
    const base = defaultAccountSettings(accountId, 1_000);
    expect(() =>
      webhookDestination({ ...base, webhookEndpoint: 'http://example.test/hook' }),
    ).toThrow('HTTPS_REQUIRED');
    expect(
      webhookDestination({ ...base, webhookEndpoint: 'http://127.0.0.1:8080/hook' }).origin,
    ).toBe('http://127.0.0.1:8080');
    expect(() =>
      webhookDestination({ ...base, webhookEndpoint: 'https://token@example.test/hook' }),
    ).toThrow('DESTINATION_MUST_NOT_CONTAIN_CREDENTIALS_OR_QUERY');
  });

  it('never invokes the global fetch with the transport as its receiver', async () => {
    // `fetch` is a method of `Window`. Held on an instance and called as `this.fetchFn(...)` it
    // runs with the transport as receiver, and a browser throws "Illegal invocation" — which this
    // class caught and reported as a connection or CORS failure, so no webhook ever left a real
    // browser while every message blamed the network. Node's fetch ignores its receiver, so this
    // has to be asserted directly rather than discovered by sending anything.
    const original = globalThis.fetch;
    let called = false;
    let receiverWasGlobal = false;
    globalThis.fetch = function (this: unknown) {
      called = true;
      // Recorded as a verdict rather than aliased, which is what a browser actually enforces.
      receiverWasGlobal = this === undefined || this === globalThis;
      return Promise.resolve(new Response('{}', { status: 200 }));
    } as unknown as typeof fetch;
    try {
      const settings = {
        ...defaultAccountSettings(accountId, 1_000),
        webhookEnabled: true,
        webhookEndpoint: 'https://receiver.example',
      };
      // Constructed without an injected fetch, which is how the application builds it.
      const transport = new WebhookTransport(
        accountId,
        () => settings,
        new WebhookCredentialStore(sessionStorage),
      );
      await transport.send(payload);
    } finally {
      globalThis.fetch = original;
    }
    expect(called).toBe(true);
    expect(receiverWasGlobal).toBe(true);
  });

  it('sends generic JSON with stable idempotency and session-only bearer credentials', async () => {
    const credentialStore = new WebhookCredentialStore(sessionStorage);
    credentialStore.write(accountId, 'session-secret');
    const settings = {
      ...defaultAccountSettings(accountId, 1_000),
      webhookEnabled: true,
      webhookEndpoint: 'https://alerts.example.test/hook',
    };
    const calls: Array<[URL | RequestInfo, RequestInit | undefined]> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      calls.push([input, init]);
      return new Response(null, { status: 204 });
    };
    const transport = new WebhookTransport(accountId, () => settings, credentialStore, fetchFn);

    await expect(transport.send(payload)).resolves.toEqual({ responseStatus: 204 });
    const [destination, init] = calls[0] ?? [];
    expect(String(destination)).toBe('https://alerts.example.test/hook');
    expect(init?.headers).toMatchObject({
      'Idempotency-Key': 'effect-id',
      Authorization: 'Bearer session-secret',
    });
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    expect(JSON.stringify(init)).not.toContain('@monitor');
  });

  it('builds an encoded ntfy topic and classifies retryable and authentication failures', async () => {
    const credentials = new WebhookCredentialStore(sessionStorage);
    const settings = {
      ...defaultAccountSettings(accountId, 1_000),
      webhookPreset: 'ntfy' as const,
      webhookEndpoint: 'https://ntfy.example.test',
      webhookTopic: 'ops alerts',
    };
    expect(() => webhookDestination(settings)).toThrow('INVALID_NTFY_TOPIC');
    expect(webhookDestination({ ...settings, webhookTopic: 'ops-alerts' }).href).toBe(
      'https://ntfy.example.test/',
    );
    const validSettings = { ...settings, webhookTopic: 'ops-alerts' };

    const retrying = new WebhookTransport(
      accountId,
      () => validSettings,
      credentials,
      async () => new Response(null, { status: 503 }),
    );
    await expect(retrying.send(payload)).rejects.toMatchObject({
      code: 'HTTP_503',
      retryable: true,
      responseStatus: 503,
    });
    const unauthorized = new WebhookTransport(
      accountId,
      () => validSettings,
      credentials,
      async () => new Response(null, { status: 401 }),
    );
    await expect(unauthorized.send(payload)).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
      retryable: false,
    });
  });
});
