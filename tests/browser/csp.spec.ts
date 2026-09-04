import { expect, test } from '@playwright/test';

/**
 * Qualifies the deployment policy documented in docs/DEPLOYMENT.md against the real production
 * bundle. The policy is only worth publishing if the application runs under it, so this asserts the
 * browser reports no violation while the app boots, renders, initializes its stores, and plays the
 * bundled alert tone.
 */
test('the documented Content Security Policy admits the production application', async ({
  page,
}) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: string[] }).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __cspViolations: string[] }).__cspViolations.push(
        `${event.violatedDirective} blocked ${event.blockedURI}`,
      );
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });

  await page.goto('/');
  // Anchored on the sign-in field rather than marketing copy, so this asserts that the policy let
  // the application boot and render rather than that a particular sentence survived.
  await expect(page.getByLabel(/matrix user id/i)).toBeVisible();

  // Exercise the parts a naive policy breaks: IndexedDB, a data: media source, and WebAssembly.
  const capabilities = await page.evaluate(async () => {
    const openedDatabase = await new Promise<boolean>((resolve) => {
      const request = indexedDB.open('ackwatch-csp-probe', 1);
      request.onsuccess = () => {
        request.result.close();
        indexedDB.deleteDatabase('ackwatch-csp-probe');
        resolve(true);
      };
      request.onerror = () => resolve(false);
    });
    const audio = new Audio(
      'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAqb/Jx6mAYDc5Y6vPyp+AgA==',
    );
    audio.muted = true;
    const audioAllowed = await audio
      .play()
      .then(() => true)
      .catch(
        (error: unknown) => !(error instanceof Error && /content security/i.test(error.message)),
      );
    // A minimal valid WebAssembly module: compiling it proves 'wasm-unsafe-eval' is effective.
    const wasmAllowed = await WebAssembly.compile(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    ).then(
      () => true,
      () => false,
    );
    return {
      openedDatabase,
      audioAllowed,
      wasmAllowed,
      reported: (window as unknown as { __cspViolations: string[] }).__cspViolations,
    };
  });

  expect(capabilities.reported, 'CSP violations reported by the page').toEqual([]);
  expect(violations, 'CSP violations reported to the console').toEqual([]);
  expect(capabilities.openedDatabase, 'IndexedDB must open under the policy').toBe(true);
  expect(capabilities.wasmAllowed, 'WebAssembly must compile under the policy').toBe(true);
  expect(capabilities.audioAllowed, 'the bundled data: alert tone must be permitted').toBe(true);
});
