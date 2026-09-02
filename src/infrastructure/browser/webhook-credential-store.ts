export interface WebhookCredentialStorePort {
  read(accountId: string): string | undefined;
  write(accountId: string, bearerToken: string): void;
  clear(accountId: string): void;
}

function key(accountId: string): string {
  let hash = 2_166_136_261;
  for (const character of accountId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `ackwatch:webhook:${(hash >>> 0).toString(16)}`;
}

export class WebhookCredentialStore implements WebhookCredentialStorePort {
  public constructor(private readonly storage: Storage = window.sessionStorage) {}

  public read(accountId: string): string | undefined {
    return this.storage.getItem(key(accountId)) ?? undefined;
  }

  public write(accountId: string, bearerToken: string): void {
    if (!bearerToken) this.clear(accountId);
    else this.storage.setItem(key(accountId), bearerToken);
  }

  public clear(accountId: string): void {
    this.storage.removeItem(key(accountId));
  }
}
