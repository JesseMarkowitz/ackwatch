import {
  AutoDiscovery,
  AutoDiscoveryAction,
  createClient,
  type LoginRequest,
  type LoginResponse,
  type MatrixClient,
} from 'matrix-js-sdk';

import type { AccountId, MatrixSessionCredentials } from '../../application/ports';
import type { Clock } from '../../domain/clock';

export interface PreparedLogin {
  readonly userId: string;
  readonly baseUrl: string;
  readonly passwordSupported: boolean;
  readonly advertisedFlows: readonly string[];
}

export interface UnauthenticatedMatrixClient {
  loginFlows(): Promise<{ readonly flows: readonly { readonly type: string }[] }>;
  loginRequest(data: LoginRequest): Promise<LoginResponse>;
}

export type UnauthenticatedClientFactory = (baseUrl: string) => UnauthenticatedMatrixClient;

function canonicalBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('Homeserver URLs must use HTTPS except for loopback development.');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function accountIdFor(userId: string, baseUrl: string): AccountId {
  return `${userId}|${new URL(baseUrl).origin}` as AccountId;
}

export class MatrixAuthentication {
  public constructor(
    private readonly clock: Clock,
    private readonly createUnauthenticated: UnauthenticatedClientFactory = (baseUrl) =>
      createClient({ baseUrl }) as MatrixClient,
  ) {}

  public async prepare(userIdInput: string, homeserverOverride?: string): Promise<PreparedLogin> {
    const userId = userIdInput.trim();
    const match = /^@[^:]+:(.+)$/.exec(userId);
    if (!match?.[1]) throw new Error('Enter a full Matrix user ID such as @you:example.org.');

    let baseUrl: string;
    if (homeserverOverride?.trim()) {
      baseUrl = canonicalBaseUrl(homeserverOverride.trim());
    } else {
      const discovered = await AutoDiscovery.findClientConfig(match[1]);
      const homeserver = discovered['m.homeserver'];
      if (homeserver.state !== AutoDiscoveryAction.SUCCESS || !homeserver.base_url) {
        throw new Error(
          'Homeserver discovery did not return a valid base URL. Use the advanced override if needed.',
        );
      }
      baseUrl = canonicalBaseUrl(homeserver.base_url);
    }

    const flows = await this.createUnauthenticated(baseUrl).loginFlows();
    const advertisedFlows = flows.flows.map(({ type }) => type);
    return {
      userId,
      baseUrl,
      passwordSupported: advertisedFlows.includes('m.login.password'),
      advertisedFlows,
    };
  }

  public async loginWithPassword(
    prepared: PreparedLogin,
    password: string,
  ): Promise<MatrixSessionCredentials> {
    if (!prepared.passwordSupported) {
      throw new Error('This homeserver does not advertise password login.');
    }
    if (!password) throw new Error('Enter the Matrix account password.');

    const response = await this.createUnauthenticated(prepared.baseUrl).loginRequest({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: prepared.userId },
      password,
      refresh_token: true,
      initial_device_display_name: 'AckWatch web',
    });
    const expiresAt =
      response.expires_in_ms === undefined ? undefined : this.clock.now() + response.expires_in_ms;
    const accountId = accountIdFor(response.user_id, prepared.baseUrl);

    return {
      accountId,
      baseUrl: prepared.baseUrl,
      userId: response.user_id,
      deviceId: response.device_id,
      accessToken: response.access_token,
      ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }
}

export function matrixErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { errcode?: unknown; data?: { errcode?: unknown } };
  if (typeof candidate.errcode === 'string') return candidate.errcode;
  return typeof candidate.data?.errcode === 'string' ? candidate.data.errcode : undefined;
}
