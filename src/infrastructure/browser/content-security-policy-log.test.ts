import { describe, expect, it, vi } from 'vitest';

import { ContentSecurityPolicyLog } from './content-security-policy-log';
import { WebhookTransport } from './webhook-transport';
import type { GenericAlertPayload } from '../../application/alert-dispatcher';
import type { AccountSettingsRecord } from '../persistence/workflow-database';

interface Listener {
  (event: { violatedDirective: string; effectiveDirective?: string; blockedURI: string }): void;
}

function fakeDocument(): { target: Parameters<typeof documentFor>[0]; emit: Listener } {
  const listeners: Listener[] = [];
  const target = {
    addEventListener: (_type: 'securitypolicyviolation', listener: Listener) =>
      listeners.push(listener),
    removeEventListener: (_type: 'securitypolicyviolation', listener: Listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  return { target, emit: (event) => listeners.forEach((listener) => listener(event)) };
}

function documentFor(target: ConstructorParameters<typeof ContentSecurityPolicyLog>[0]) {
  return new ContentSecurityPolicyLog(target);
}

const settings = {
  webhookEndpoint: 'https://ntfy.example/',
  webhookPreset: 'generic',
  webhookTopic: '',
  webhookTimeoutMs: 5_000,
} as unknown as AccountSettingsRecord;

const payload = { effectId: 'effect' } as unknown as GenericAlertPayload;

describe('ContentSecurityPolicyLog', () => {
  it('records only refused connections, by origin', () => {
    const { target, emit } = fakeDocument();
    const log = documentFor(target);
    log.install();

    emit({ violatedDirective: 'connect-src', blockedURI: 'https://ntfy.example/topic' });
    // Not a connection, so it is not this log's business.
    emit({ violatedDirective: 'img-src', blockedURI: 'https://images.example/logo.png' });
    // Not a URL at all: `blockedURI` is a keyword for inline violations.
    emit({ violatedDirective: 'connect-src', blockedURI: 'inline' });

    expect(log.blockedOrigins()).toEqual(['https://ntfy.example']);
    expect(log.wasBlocked('https://ntfy.example/some/other/path')).toBe(true);
    expect(log.wasBlocked('https://images.example/logo.png')).toBe(false);
    expect(log.wasBlocked('https://never-seen.example/')).toBe(false);
  });

  it('stops recording once uninstalled', () => {
    const { target, emit } = fakeDocument();
    const log = documentFor(target);
    const uninstall = log.install();
    uninstall();

    emit({ violatedDirective: 'connect-src', blockedURI: 'https://ntfy.example/' });

    expect(log.blockedOrigins()).toEqual([]);
  });

  it('prefers the effective directive, which is what a browser reports for a fallback', () => {
    const { target, emit } = fakeDocument();
    const log = documentFor(target);
    log.install();

    // A policy with no connect-src blocks the request under default-src, and browsers name
    // connect-src as the effective directive while violatedDirective reads default-src.
    emit({
      violatedDirective: 'default-src',
      effectiveDirective: 'connect-src',
      blockedURI: 'https://ntfy.example/',
    });

    expect(log.wasBlocked('https://ntfy.example/')).toBe(true);
  });
});

describe('WebhookTransport with a policy log', () => {
  /*
   * These two are the same TypeError from `fetch`, and the operator has to do entirely different
   * things about them: fix the URL, or ask whoever deployed AckWatch to widen its policy. Before
   * the log existed, both said the connection failed and neither said which.
   */
  it('reports a refused connection as a policy block, and does not retry it', async () => {
    const { target, emit } = fakeDocument();
    const log = documentFor(target);
    log.install();
    const fetchFn = vi.fn(async () => {
      emit({ violatedDirective: 'connect-src', blockedURI: 'https://ntfy.example/' });
      throw new TypeError('Failed to fetch');
    });
    const transport = new WebhookTransport(
      'account',
      () => settings,
      { read: () => undefined, write: () => undefined, clear: () => undefined },
      fetchFn as unknown as typeof fetch,
      log,
    );

    await expect(transport.send(payload)).rejects.toMatchObject({
      code: 'BLOCKED_BY_CONTENT_SECURITY_POLICY',
      // Waiting does not change a deployment's policy, so retrying only burns attempts.
      retryable: false,
    });
  });

  it('reports an unreachable destination as a connection failure, keeping what the browser said', async () => {
    const { target } = fakeDocument();
    const log = documentFor(target);
    log.install();
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const transport = new WebhookTransport(
      'account',
      () => settings,
      { read: () => undefined, write: () => undefined, clear: () => undefined },
      fetchFn as unknown as typeof fetch,
      log,
    );

    await expect(transport.send(payload)).rejects.toMatchObject({
      code: 'CONNECTION_OR_CORS_FAILURE',
      retryable: true,
      underlying: 'TypeError: Failed to fetch',
    });
  });
});
