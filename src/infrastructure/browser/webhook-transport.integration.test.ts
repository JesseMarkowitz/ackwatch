/// <reference types="node" />
// @vitest-environment node

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import type { GenericAlertPayload } from '../../application/alert-dispatcher';
import { defaultAccountSettings } from '../persistence/workflow-repository';
import { WebhookTransport } from './webhook-transport';

const accountId = '@monitor:example.test|https://matrix.example.test';
const credential = 'receiver-secret-value';
const payload: GenericAlertPayload = {
  schema: 'ackwatch.alert.v1',
  effectId: 'item-cycle-initial-0',
  eventKind: 'new_activity',
  detectedAt: 1_000,
  evaluatedAt: 2_000,
  ageMs: 1_000,
  status: 'NEW',
  unseenCount: 1,
  escalationStage: 0,
};

interface CapturedRequest {
  readonly url: string;
  readonly authorization?: string;
  readonly idempotencyKey?: string;
  readonly body: string;
}

const servers: Array<ReturnType<typeof createServer>> = [];

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function receiver(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => void handler(request, response));
  servers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Receiver address unavailable.');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolvePromise, reject) =>
            server.close((error) => (error ? reject(error) : resolvePromise())),
          ),
      ),
  );
});

describe('WebhookTransport loopback contract', () => {
  it('sends a content-free payload, bearer header, and stable idempotency key over HTTP', async () => {
    const captured: CapturedRequest[] = [];
    const endpoint = await receiver(async (request, response) => {
      const idempotencyHeader = request.headers['idempotency-key'];
      captured.push({
        url: request.url ?? '',
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        ...(idempotencyHeader === undefined
          ? {}
          : {
              idempotencyKey: Array.isArray(idempotencyHeader)
                ? idempotencyHeader.join(',')
                : idempotencyHeader,
            }),
        body: await readBody(request),
      });
      response.writeHead(204).end();
    });
    const settings = {
      ...defaultAccountSettings(accountId, 1_000),
      webhookEnabled: true,
      webhookEndpoint: `${endpoint}/ackwatch`,
    };
    const credentials = { read: () => credential, write() {}, clear() {} };
    const transport = new WebhookTransport(accountId, () => settings, credentials);

    await transport.send(payload);
    await transport.send(payload);

    expect(captured).toHaveLength(2);
    expect(captured.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      payload.effectId,
      payload.effectId,
    ]);
    expect(captured[0]).toMatchObject({
      url: '/ackwatch',
      authorization: `Bearer ${credential}`,
      body: JSON.stringify(payload),
    });
    const serialized = JSON.stringify(captured);
    for (const forbidden of [accountId, 'room', 'sender', 'preview', 'formatted_body', 'mxc://']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('classifies receiver rate limits and timeouts without exposing response bodies', async () => {
    const rateLimited = await receiver(async (request, response) => {
      await readBody(request);
      response.writeHead(429, { 'Content-Type': 'text/plain' }).end('sensitive receiver detail');
    });
    const timeout = await receiver(async (request, response) => {
      await readBody(request);
      setTimeout(() => response.writeHead(204).end(), 1_500);
    });
    const base = defaultAccountSettings(accountId, 1_000);
    const credentials = { read: () => undefined, write() {}, clear() {} };
    const limitedTransport = new WebhookTransport(
      accountId,
      () => ({ ...base, webhookEndpoint: rateLimited }),
      credentials,
    );
    await expect(limitedTransport.send(payload)).rejects.toMatchObject({
      code: 'HTTP_429',
      retryable: true,
      responseStatus: 429,
    });
    await expect(limitedTransport.send(payload)).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining('sensitive'),
    );

    const timeoutTransport = new WebhookTransport(
      accountId,
      () => ({ ...base, webhookEndpoint: timeout, webhookTimeoutMs: 1_000 }),
      credentials,
    );
    await expect(timeoutTransport.send(payload)).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
  });
});
