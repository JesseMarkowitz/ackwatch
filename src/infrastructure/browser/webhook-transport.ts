import {
  AlertTransportError,
  alertMessage,
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
    // Wrapped, not passed bare. `fetch` is a method of `Window`, and holding it on an instance
    // means `this.fetchFn(...)` invokes it with the transport as receiver, which browsers reject
    // with "Illegal invocation". The resulting TypeError was caught below and relabelled a
    // connection or CORS failure, so every webhook delivery failed in a browser while pointing the
    // reader at the network. Node's fetch does not care about the receiver, so the whole test
    // suite passed against it.
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
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
                title: payload.test ? 'AckWatch test notification' : 'AckWatch: attention required',
                message: alertMessage(payload),
                // No `sequence_id`. That field is ntfy's handle for updating or deleting a
                // notification it already accepted, and it enforces its own format; AckWatch's
                // effect ids are `itemId|cycleId|kind|stage`, which ntfy rejects outright with
                // "sequence ID invalid". Every real ntfy alert failed with HTTP 400 because of it.
                // AckWatch never updates or deletes a published notification, so it has no
                // business claiming a sequence id. Idempotency travels in the `Idempotency-Key`
                // header, which is the generic mechanism and applies to both presets.
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
      throw new AlertTransportError(
        'CONNECTION_OR_CORS_FAILURE',
        true,
        undefined,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
