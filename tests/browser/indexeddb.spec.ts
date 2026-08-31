import { expect, test } from '@playwright/test';

test('IndexedDB atomically rolls back and restores a committed workflow after reload', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const databaseName = `ackwatch-browser-${testInfo.project.name}-${Date.now()}`;
  const rolledBack = await page.evaluate(async (name) => {
    const open = () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('activities', { keyPath: 'id' });
          request.result.createObjectStore('items', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const count = (database: IDBDatabase, store: string) =>
      new Promise<number>((resolve, reject) => {
        const request = database.transaction(store).objectStore(store).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const database = await open();
    const aborted = database.transaction(['activities', 'items'], 'readwrite');
    aborted.objectStore('activities').add({ id: 'event' });
    aborted.objectStore('items').add({ id: 'item' });
    aborted.abort();
    await new Promise<void>((resolve) => {
      aborted.onabort = () => resolve();
    });
    const rolledBack = [await count(database, 'activities'), await count(database, 'items')];
    const committed = database.transaction(['activities', 'items'], 'readwrite');
    committed.objectStore('activities').add({ id: 'event' });
    committed.objectStore('items').add({ id: 'item' });
    await new Promise<void>((resolve, reject) => {
      committed.oncomplete = () => resolve();
      committed.onerror = () => reject(committed.error);
    });
    database.close();
    return rolledBack;
  }, databaseName);
  expect(rolledBack).toEqual([0, 0]);

  await page.reload();
  const restored = await page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['activities', 'items']);
    const counts = await Promise.all(
      ['activities', 'items'].map(
        (store) =>
          new Promise<number>((resolve, reject) => {
            const request = transaction.objectStore(store).count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          }),
      ),
    );
    database.close();
    indexedDB.deleteDatabase(name);
    return counts;
  }, databaseName);
  expect(restored).toEqual([1, 1]);
});

test('IndexedDB surfaces a blocked schema upgrade until the old connection closes', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const databaseName = `ackwatch-blocked-${testInfo.project.name}-${Date.now()}`;

  const wasBlocked = await page.evaluate(async (name) => {
    const first = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise<boolean>((resolve, reject) => {
      const upgrade = indexedDB.open(name, 2);
      let wasBlocked = false;
      upgrade.onblocked = () => {
        wasBlocked = true;
        first.close();
      };
      upgrade.onupgradeneeded = () => upgrade.result.createObjectStore('v2');
      upgrade.onsuccess = () => {
        upgrade.result.close();
        indexedDB.deleteDatabase(name);
        resolve(wasBlocked);
      };
      upgrade.onerror = () => reject(upgrade.error);
    });
  }, databaseName);
  expect(wasBlocked).toBe(true);
});
