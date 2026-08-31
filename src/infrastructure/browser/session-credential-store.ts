import { z } from 'zod';

import type { AccountId, CredentialStore, MatrixSessionCredentials } from '../../application/ports';

const storageKey = 'ackwatch.matrix-session.v1';
const credentialsSchema = z.object({
  accountId: z.string(),
  baseUrl: z.url(),
  userId: z.string().startsWith('@'),
  deviceId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite().optional(),
});

export class SessionCredentialStore implements CredentialStore {
  public constructor(private readonly storage: Storage = window.sessionStorage) {}

  public async read(): Promise<MatrixSessionCredentials | undefined> {
    const serialized = this.storage.getItem(storageKey);
    if (!serialized) return undefined;

    try {
      const parsed = credentialsSchema.safeParse(JSON.parse(serialized));
      if (!parsed.success) {
        this.storage.removeItem(storageKey);
        return undefined;
      }
      return {
        accountId: parsed.data.accountId as AccountId,
        baseUrl: parsed.data.baseUrl,
        userId: parsed.data.userId,
        deviceId: parsed.data.deviceId,
        accessToken: parsed.data.accessToken,
        ...(parsed.data.refreshToken === undefined
          ? {}
          : { refreshToken: parsed.data.refreshToken }),
        ...(parsed.data.expiresAt === undefined ? {} : { expiresAt: parsed.data.expiresAt }),
      };
    } catch {
      this.storage.removeItem(storageKey);
      return undefined;
    }
  }

  public async write(credentials: MatrixSessionCredentials): Promise<void> {
    this.storage.setItem(storageKey, JSON.stringify(credentialsSchema.parse(credentials)));
  }

  public async clear(): Promise<void> {
    this.storage.removeItem(storageKey);
  }
}
