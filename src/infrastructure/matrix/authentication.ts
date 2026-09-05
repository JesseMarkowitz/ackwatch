import {
  AutoDiscovery,
  AutoDiscoveryAction,
  AutoDiscoveryError,
  type ClientConfig,
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

/** Injectable so the failure paths below can be exercised without a network. */
export type ClientConfigDiscovery = (serverName: string) => Promise<ClientConfig>;

/**
 * Says what went wrong with discovery, rather than what most often goes wrong with discovery.
 *
 * The three failures below are indistinguishable to the operator and have nothing in common: one
 * is the homeserver publishing nothing, one is a header missing from a file, one is this
 * deployment's own policy. A single sentence covering all three sent a developer to check the
 * homeserver that was working correctly, because the file it serves was refused to the page
 * reading it. `AutoDiscovery` already separates them and the caller was discarding the state.
 */
function describeDiscoveryFailure(
  serverName: string,
  homeserver: ClientConfig['m.homeserver'],
): string {
  const wellKnown = `https://${serverName}/.well-known/matrix/client`;
  const override = 'Enter the homeserver URL directly with the advanced override.';

  // No document at all: the server answered, with a 404. Nothing is broken; this domain simply
  // does not advertise a homeserver, which is normal for a server whose name is its host.
  if (homeserver.state === AutoDiscoveryAction.PROMPT && !homeserver.error) {
    return `No discovery document at ${wellKnown}, so ${serverName} does not advertise a homeserver address. ${override}`;
  }

  // The document exists but this page was not allowed to read it, or it was not JSON. The usual
  // cause is that the .well-known file is served by the reverse proxy rather than by the
  // homeserver, so it carries none of the homeserver's CORS headers.
  if (homeserver.state === AutoDiscoveryAction.FAIL_PROMPT) {
    return `${wellKnown} could not be read by this page. The file usually needs an Access-Control-Allow-Origin header, which it does not inherit from the homeserver; a Content-Security-Policy on this deployment that omits https://${serverName} does the same thing. ${override}`;
  }

  // Discovery worked and the address it named did not behave like a homeserver.
  if (homeserver.error === AutoDiscoveryError.InvalidHomeserver) {
    return `${wellKnown} names ${homeserver.base_url ?? 'a homeserver'}, which did not answer as a Matrix homeserver. Its /_matrix/client/versions endpoint is unreachable or is not permitted to this page. ${override}`;
  }
  if (homeserver.error === AutoDiscoveryError.InvalidHsBaseUrl) {
    return `${wellKnown} advertises a homeserver URL that is not usable. ${override}`;
  }
  if (homeserver.error === AutoDiscoveryError.UnsupportedHomeserverSpecVersion) {
    return `${homeserver.base_url ?? serverName} does not support a Matrix specification version this client can use.`;
  }

  return `Homeserver discovery for ${serverName} failed: ${homeserver.error ?? homeserver.state}. ${override}`;
}

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
    private readonly discoverClientConfig: ClientConfigDiscovery = (serverName) =>
      AutoDiscovery.findClientConfig(serverName),
  ) {}

  public async prepare(userIdInput: string, homeserverOverride?: string): Promise<PreparedLogin> {
    const userId = userIdInput.trim();
    const match = /^@[^:]+:(.+)$/.exec(userId);
    if (!match?.[1]) throw new Error('Enter a full Matrix user ID such as @you:example.org.');

    let baseUrl: string;
    if (homeserverOverride?.trim()) {
      baseUrl = canonicalBaseUrl(homeserverOverride.trim());
    } else {
      const discovered = await this.discoverClientConfig(match[1]);
      const homeserver = discovered['m.homeserver'];
      if (homeserver.state !== AutoDiscoveryAction.SUCCESS || !homeserver.base_url) {
        throw new Error(describeDiscoveryFailure(match[1], homeserver));
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
