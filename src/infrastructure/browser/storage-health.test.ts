import 'fake-indexeddb/auto';

import { describe, expect, it, vi } from 'vitest';

import { BrowserStorageHealth } from './storage-health';

describe('BrowserStorageHealth', () => {
  it('reports estimates without requesting persistence during inspection', async () => {
    const persist = vi.fn(async () => true);
    const health = new BrowserStorageHealth(window.indexedDB, {
      estimate: async () => ({ usage: 1_000, quota: 10_000 }),
      persisted: async () => false,
      persist,
    });

    await expect(health.inspect()).resolves.toEqual({
      available: true,
      persistenceSupported: true,
      persistent: false,
      usage: 1_000,
      quota: 10_000,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports granted, denied, unsupported, and failed persistence explicitly', async () => {
    await expect(
      new BrowserStorageHealth(window.indexedDB, {
        persist: async () => true,
      }).requestPersistence(),
    ).resolves.toMatchObject({ persistent: true });
    await expect(
      new BrowserStorageHealth(window.indexedDB, {
        persist: async () => false,
      }).requestPersistence(),
    ).resolves.toMatchObject({ persistent: false });
    await expect(
      new BrowserStorageHealth(window.indexedDB, {}).requestPersistence(),
    ).resolves.toMatchObject({ persistenceSupported: false });
    await expect(
      new BrowserStorageHealth(window.indexedDB, {
        persist: async () => {
          throw new Error('denied by policy');
        },
      }).requestPersistence(),
    ).resolves.toMatchObject({ persistent: false, fault: 'denied by policy' });
  });

  it('treats unavailable or denied storage inspection as a fatal durability boundary', async () => {
    await expect(new BrowserStorageHealth(null, null).inspect()).resolves.toMatchObject({
      available: false,
    });
    await expect(
      new BrowserStorageHealth(window.indexedDB, {
        estimate: async () => {
          throw new DOMException('quota unavailable', 'QuotaExceededError');
        },
      }).inspect(),
    ).resolves.toMatchObject({ available: false, fault: 'quota unavailable' });
  });
});
