import { describe, expect, it } from 'vitest';

import type { AccountId } from '../../application/ports';
import { SessionCredentialStore } from './session-credential-store';

describe('SessionCredentialStore', () => {
  it('keeps credentials in session storage and clears malformed data safely', async () => {
    const store = new SessionCredentialStore(window.sessionStorage);
    window.sessionStorage.clear();
    await store.write({
      accountId: '@monitor:example.test|https://example.test' as AccountId,
      baseUrl: 'https://example.test',
      userId: '@monitor:example.test',
      deviceId: 'DEVICE',
      accessToken: 'access',
    });

    await expect(store.read()).resolves.toMatchObject({ accessToken: 'access' });
    window.sessionStorage.setItem('ackwatch.matrix-session.v1', '{bad json');
    await expect(store.read()).resolves.toBeUndefined();
  });
});
