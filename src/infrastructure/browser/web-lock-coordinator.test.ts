import { describe, expect, it, vi } from 'vitest';

import type { AccountId } from '../../application/ports';
import { WebLockCoordinator } from './web-lock-coordinator';

describe('WebLockCoordinator', () => {
  it('returns an owned lease and holds the lock until release', async () => {
    let callbackFinished = false;
    const manager = {
      request: async <T>(
        name: string,
        _options: { mode: 'exclusive'; ifAvailable: true },
        callback: (lock: { name: string } | null) => Promise<T>,
      ) => {
        const result = await callback({ name });
        callbackFinished = true;
        return result;
      },
    };
    const coordinator = new WebLockCoordinator(manager);

    const lease = await coordinator.acquire(
      '@monitor:example.test|https://example.test' as AccountId,
    );

    expect(lease).toBeDefined();
    expect(callbackFinished).toBe(false);
    await lease?.release();
    await vi.waitFor(() => expect(callbackFinished).toBe(true));
  });

  it('returns unavailable without opening account stores', async () => {
    const manager = {
      request: async <T>(
        _name: string,
        _options: { mode: 'exclusive'; ifAvailable: true },
        callback: (lock: null) => Promise<T>,
      ) => await callback(null),
    };
    const coordinator = new WebLockCoordinator(manager);

    await expect(
      coordinator.acquire('@monitor:example.test|https://example.test' as AccountId),
    ).resolves.toBeUndefined();
  });
});
