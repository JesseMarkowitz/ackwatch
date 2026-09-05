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

/**
 * The listener the application installs is only useful if the browser actually reports a refused
 * connection this way, and reports it with the directive the log filters on. Firefox and Chromium
 * populate `effectiveDirective` differently enough to be worth asserting rather than assuming: a
 * silent difference here turns the explained failure back into an unexplained one, in one engine
 * only.
 */
test('a refused connection is reported to the page as a connect-src violation', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByLabel(/matrix user id/i)).toBeVisible();

  const violation = await page.evaluate(async () => {
    const seen = new Promise<{ violated: string; effective: string; blocked: string }>(
      (resolve) => {
        document.addEventListener(
          'securitypolicyviolation',
          (event) =>
            resolve({
              violated: event.violatedDirective,
              effective: event.effectiveDirective,
              blocked: event.blockedURI,
            }),
          { once: true },
        );
      },
    );
    // Not listed in connect-src, so the browser refuses it before any network activity.
    await fetch('https://blocked.invalid/hook').catch(() => undefined);
    return seen;
  });

  expect(violation.effective || violation.violated).toContain('connect-src');
  expect(violation.blocked).toContain('blocked.invalid');
});

/**
 * A deployment replaces the alert sound by dropping a file beside index.html, which only works if
 * the policy admits both halves: the HEAD probe that finds it (`connect-src 'self'`) and the
 * element that plays it (`media-src 'self'`). Getting `media-src` wrong fails silently — the
 * bundled tone plays and the deployer's file is simply never heard.
 */
test("a deployment's own alert tone is admitted by the policy", async ({ page }) => {
  // 80 ms of a real 440 Hz tone, standing in for the file a deployer would drop in. It has to
  // contain actual samples: Firefox declines to report metadata for a WAV whose data chunk is
  // empty, while Chromium accepts one, so an empty fixture fails in one engine only.
  const wav = Buffer.from(
    'UklGRiQFAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAFAAAAAJUK6xPlGrIe3R5iG6oUgAv7AFj22e' +
      'ye5YHhAOEo5Jzql/MK/rcIXhLYGUQeHB9GHBgWTg3wAjv4cO645v7h0OBS4znp0fEW/NEGvhCxGLgdPB8OHXAXDg/j' +
      'BCX6GPDs55niwOCZ4uznGPAl+uMEDg9wFw4dPB+4HbEYvhDRBhb80fE56VLj0OD+4bjmcO47+PACTg0YFkYcHB9EHt' +
      'gZXhK3CAr+l/Oc6ijkAOGB4Z7l2exY9vsAgAuqFGIb3R6yHuUa6xOVCgAAa/UV7BvlTuEj4Z7kVuuA9AX/qAknE2Ia' +
      'fx4AH9gbZBVpDPYBSfei7SjmvOHk4Lrj6Omy8hD9xQeQEUgZAh4wH64cxxYvDuoDL/lC70/nSOLE4PLikOjy8B372w' +
      'XoDxQYZx1AH2cdFBjoD9sFHfvy8JDo8uLE4EjiT+dC7y/56gMvDscWrhwwHwIeSBmQEcUHEP2y8ujpuuPk4LzhKOai' +
      '7Un39gFpDGQV2BsAH38eYhonE6gJBf+A9FbrnuQj4U7hG+UV7Gv1AACVCusT5RqyHt0eYhuqFIAL+wBY9tnsnuWB4Q' +
      'DhKOSc6pfzCv63CF4S2BlEHhwfRhwYFk4N8AI7+HDuuOb+4dDgUuM56dHxFvzRBr4QsRi4HTwfDh1wFw4P4wQl+hjw' +
      '7OeZ4sDgmeLs5xjwJfrjBA4PcBcOHTwfuB2xGL4Q0QYW/NHxOelS49Dg/uG45nDuO/jwAk4NGBZGHBwfRB7YGV4Stw' +
      'gK/pfznOoo5ADhgeGe5dnsWPb7AIALqhRiG90esh7lGusTlQoAAGv1Fewb5U7hI+Ge5FbrgPQF/6gJJxNiGn8eAB/Y' +
      'G2QVaQz2AUn3ou0o5rzh5OC64+jpsvIQ/cUHkBFIGQIeMB+uHMcWLw7qAy/5Qu9P50jixODy4pDo8vAd+9sF6A8UGG' +
      'cdQB9nHRQY6A/bBR378vCQ6PLixOBI4k/nQu8v+eoDLw7HFq4cMB8CHkgZkBHFBxD9svLo6brj5OC84Sjmou1J9/YB' +
      'aQxkFdgbAB9/HmIaJxOoCQX/gPRW657kI+FO4RvlFexr9QAAlQrrE+Uash7dHmIbqhSAC/sAWPbZ7J7lgeEA4SjknO' +
      'qX8wr+twheEtgZRB4cH0YcGBZODfACO/hw7rjm/uHQ4FLjOenR8Rb80Qa+ELEYuB08Hw4dcBcOD+MEJfoY8OznmeLA' +
      '4Jni7OcY8CX64wQOD3AXDh08H7gdsRi+ENEGFvzR8TnpUuPQ4P7huOZw7jv48AJODRgWRhwcH0Qe2BleErcICv6X85' +
      'zqKOQA4YHhnuXZ7Fj2+wCAC6oUYhvdHrIe5RrrE5UKAABr9RXsG+VO4SPhnuRW64D0Bf+oCScTYhp/HgAf2BtkFWkM' +
      '9gFJ96LtKOa84eTguuPo6bLyEP3FB5ARSBkCHjAfrhzHFi8O6gMv+ULvT+dI4sTg8uKQ6PLwHfvbBegPFBhnHUAfZx' +
      '0UGOgP2wUd+/LwkOjy4sTgSOJP50LvL/nqAy8OxxauHDAfAh5IGZARxQcQ/bLy6Om64+TgvOEo5qLtSff2AWkMZBXY' +
      'GwAffx5iGicTqAkF/4D0Vuue5CPhTuEb5RXsa/UAAJUK6xPlGrIe3R5iG6oUgAv7AFj22eye5YHhAOEo5Jzql/MK/r' +
      'cIXhLYGUQeHB9GHBgWTg3wAjv4cO645v7h0OBS4znp0fEW/NEGvhCxGA==',
    'base64',
  );
  await page.route('**/alert-tone.wav', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: wav }),
  );

  await page.addInitScript(() => {
    (window as unknown as { __v: string[] }).__v = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as unknown as { __v: string[] }).__v.push(
        `${event.effectiveDirective || event.violatedDirective} blocked ${event.blockedURI}`,
      ),
    );
  });
  await page.goto('/');
  await expect(page.getByLabel(/matrix user id/i)).toBeVisible();

  const probe = await page.evaluate(async () => {
    const response = await fetch('./alert-tone.wav', { method: 'HEAD', cache: 'no-store' });
    const audio = new Audio('./alert-tone.wav');
    const loadable = await new Promise<boolean>((resolve) => {
      audio.addEventListener('loadedmetadata', () => resolve(true), { once: true });
      audio.addEventListener('error', () => resolve(false), { once: true });
      audio.load();
    });
    return { status: response.status, type: response.headers.get('content-type'), loadable };
  });

  expect(probe.status).toBe(200);
  expect(probe.type).toContain('audio/wav');
  expect(probe.loadable).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __v: string[] }).__v)).toEqual([]);
});
