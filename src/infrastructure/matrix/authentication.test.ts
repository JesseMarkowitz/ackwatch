import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../../domain/clock';
import { MatrixAuthentication, type UnauthenticatedMatrixClient } from './authentication';

const clock: Clock = { now: () => 1_000 };

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
});
