import { AutoDiscoveryAction, AutoDiscoveryError, type ClientConfig } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../../domain/clock';
import {
  MatrixAuthentication,
  type ClientConfigDiscovery,
  type UnauthenticatedMatrixClient,
} from './authentication';

const clock: Clock = { now: () => 1_000 };

const unusedClient: UnauthenticatedMatrixClient = {
  loginFlows: async () => ({ flows: [{ type: 'm.login.password' }] }),
  loginRequest: async () => {
    throw new Error('not reached');
  },
};

function discovery(homeserver: Partial<ClientConfig['m.homeserver']>): ClientConfigDiscovery {
  return async () =>
    ({
      'm.homeserver': {
        state: AutoDiscoveryAction.PROMPT,
        error: null,
        base_url: null,
        ...homeserver,
      },
      'm.identity_server': { state: AutoDiscoveryAction.PROMPT, error: null, base_url: null },
    }) as ClientConfig;
}

describe('MatrixAuthentication', () => {
  it('queries advertised flows and requests refresh-token capable password login', async () => {
    const loginRequest = vi.fn(async () => ({
      access_token: 'secret-access',
      refresh_token: 'secret-refresh',
      expires_in_ms: 60_000,
      device_id: 'DEVICE',
      user_id: '@monitor:example.test',
    }));
    const client: UnauthenticatedMatrixClient = {
      loginFlows: async () => ({ flows: [{ type: 'm.login.password' }] }),
      loginRequest,
    };
    const auth = new MatrixAuthentication(clock, () => client);

    const prepared = await auth.prepare('@monitor:example.test', 'https://matrix.example.test/');
    const credentials = await auth.loginWithPassword(prepared, 'not-logged');

    expect(prepared).toMatchObject({
      passwordSupported: true,
      baseUrl: 'https://matrix.example.test',
    });
    expect(loginRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'm.login.password',
        password: 'not-logged',
        refresh_token: true,
      }),
    );
    expect(credentials).toMatchObject({
      accountId: '@monitor:example.test|https://matrix.example.test',
      expiresAt: 61_000,
    });
  });

  it('does not offer password entry when the server omits that flow', async () => {
    const auth = new MatrixAuthentication(clock, () => ({
      loginFlows: async () => ({ flows: [{ type: 'm.login.sso' }] }),
      loginRequest: vi.fn(),
    }));
    const prepared = await auth.prepare('@monitor:example.test', 'https://matrix.example.test');

    expect(prepared.passwordSupported).toBe(false);
    await expect(auth.loginWithPassword(prepared, 'password')).rejects.toThrow(
      /does not advertise/i,
    );
  });

  it('rejects non-loopback HTTP homeservers', async () => {
    const auth = new MatrixAuthentication(clock, () => ({
      loginFlows: vi.fn(),
      loginRequest: vi.fn(),
    }));

    await expect(auth.prepare('@monitor:example.test', 'http://example.test')).rejects.toThrow(
      /https/i,
    );
  });

  /*
   * These three failures reached the operator as one sentence about discovery not returning a base
   * URL, which sent them to check a homeserver that was answering correctly. They have nothing in
   * common and each has a different fix, so each has to say which one happened.
   */
  it('separates a homeserver that advertises nothing from one whose document cannot be read', async () => {
    const missing = new MatrixAuthentication(
      clock,
      () => unusedClient,
      discovery({ state: AutoDiscoveryAction.PROMPT, error: null }),
    );
    await expect(missing.prepare('@monitor:example.test')).rejects.toThrow(
      /No discovery document at https:\/\/example\.test\/\.well-known\/matrix\/client/,
    );

    const refused = new MatrixAuthentication(
      clock,
      () => unusedClient,
      discovery({ state: AutoDiscoveryAction.FAIL_PROMPT, error: AutoDiscoveryError.Invalid }),
    );
    // The cause the developer actually hit: the file exists and is correct, and the browser is not
    // allowed to read it, because .well-known is served by the proxy and carries no CORS header.
    await expect(refused.prepare('@monitor:example.test')).rejects.toThrow(
      /Access-Control-Allow-Origin/,
    );
  });

  it('reports a discovered homeserver that does not answer as a homeserver', async () => {
    const auth = new MatrixAuthentication(
      clock,
      () => unusedClient,
      discovery({
        state: AutoDiscoveryAction.FAIL_ERROR,
        error: AutoDiscoveryError.InvalidHomeserver,
        base_url: 'https://matrix.example.test',
      }),
    );

    await expect(auth.prepare('@monitor:example.test')).rejects.toThrow(
      /names https:\/\/matrix\.example\.test, which did not answer as a Matrix homeserver/,
    );
  });

  it('never runs discovery when an override is given', async () => {
    const discover = vi.fn(discovery({ state: AutoDiscoveryAction.PROMPT }));
    const auth = new MatrixAuthentication(clock, () => unusedClient, discover);

    await auth.prepare('@monitor:example.test', 'https://matrix.example.test');

    expect(discover).not.toHaveBeenCalled();
  });
});
