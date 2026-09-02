import {
  AlertTransportError,
  type AlertTransport,
  type GenericAlertPayload,
} from '../../application/alert-dispatcher';
import type { AccountSettingsRecord } from '../persistence/workflow-database';
import type { WebhookCredentialStorePort } from './webhook-credential-store';

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function webhookDestination(settings: AccountSettingsRecord): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(settings.webhookEndpoint);
  } catch {
    throw new AlertTransportError('INVALID_DESTINATION', false);
  }
  if (endpoint.username || endpoint.password || endpoint.search) {
    throw new AlertTransportError('DESTINATION_MUST_NOT_CONTAIN_CREDENTIALS_OR_QUERY', false);
  }
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && isLoopback(endpoint.hostname))
  ) {
    throw new AlertTransportError('HTTPS_REQUIRED', false);
  }
  if (settings.webhookPreset === 'ntfy') {
    if (!/^[-_A-Za-z0-9]{1,64}$/u.test(settings.webhookTopic)) {
      throw new AlertTransportError('INVALID_NTFY_TOPIC', false);
    }
  }
  return endpoint;
}

export class WebhookTransport implements AlertTransport {
  public readonly kind = 'webhook' as const;

  public constructor(
    private readonly accountId: string,
    private readonly settings: () => AccountSettingsRecord,
    private readonly credentials: WebhookCredentialStorePort,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  public async send(payload: GenericAlertPayload): Promise<{ responseStatus: number }> {
    const settings = this.settings();
    const destination = webhookDestination(settings);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), settings.webhookTimeoutMs);
    try {
      const token = this.credentials.read(this.accountId);
      const response = await this.fetchFn(destination, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': payload.effectId,
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(
          settings.webhookPreset === 'ntfy'
            ? {
                topic: settings.webhookTopic,
                title: 'AckWatch attention required',
                message: `Matrix activity needs attention. Status ${payload.status}; escalation stage ${payload.escalationStage}; age ${payload.ageMs} ms.`,
                sequence_id: payload.effectId,
              }
            : payload,
        ),
        signal: abort.signal,
      });
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        const code =
          response.status === 401 || response.status === 403
            ? 'AUTHENTICATION_FAILED'
            : `HTTP_${response.status}`;
        throw new AlertTransportError(code, retryable, response.status);
      }
      return { responseStatus: response.status };
    } catch (error: unknown) {
      if (error instanceof AlertTransportError) throw error;
      if (abort.signal.aborted) throw new AlertTransportError('TIMEOUT', true);
      throw new AlertTransportError('CONNECTION_OR_CORS_FAILURE', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
