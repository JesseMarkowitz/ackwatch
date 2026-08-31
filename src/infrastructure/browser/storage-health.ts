export interface BrowserStorageSnapshot {
  readonly available: boolean;
  readonly persistenceSupported: boolean;
  readonly persistent?: boolean;
  readonly usage?: number;
  readonly quota?: number;
  readonly fault?: string;
}

export interface StorageManagerPort {
  estimate?: () => Promise<StorageEstimate>;
  persist?: () => Promise<boolean>;
  persisted?: () => Promise<boolean>;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

export class BrowserStorageHealth {
  public constructor(
    private readonly indexedDBFactory: IDBFactory | null | undefined = globalThis.indexedDB,
    private readonly storageManager: StorageManagerPort | null | undefined = globalThis.navigator
      ?.storage,
  ) {}

  public async inspect(): Promise<BrowserStorageSnapshot> {
    if (!this.indexedDBFactory) {
      return {
        available: false,
        persistenceSupported: false,
        fault: 'IndexedDB is unavailable; durable workflow acceptance cannot start.',
      };
    }
    try {
      const [estimate, persistent] = await Promise.all([
        this.storageManager?.estimate?.(),
        this.storageManager?.persisted?.(),
      ]);
      return {
        available: true,
        persistenceSupported: Boolean(this.storageManager?.persist),
        ...(persistent === undefined ? {} : { persistent }),
        ...(estimate?.usage === undefined ? {} : { usage: estimate.usage }),
        ...(estimate?.quota === undefined ? {} : { quota: estimate.quota }),
      };
    } catch (error: unknown) {
      return {
        available: false,
        persistenceSupported: Boolean(this.storageManager?.persist),
        fault: errorMessage(error, 'Browser storage inspection failed.'),
      };
    }
  }

  /** Call only after the UI explains persistence and the user requests it. */
  public async requestPersistence(): Promise<BrowserStorageSnapshot> {
    const inspected = await this.inspect();
    if (!inspected.available || !this.storageManager?.persist) return inspected;
    try {
      const persistent = await this.storageManager.persist();
      return { ...inspected, persistent };
    } catch (error: unknown) {
      return {
        ...inspected,
        persistent: false,
        fault: errorMessage(error, 'The persistent-storage request failed.'),
      };
    }
  }
}
