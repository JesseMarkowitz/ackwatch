import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'artifacts/reports/browser-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    // Out of scope for V1 and not run (§8.3a, amended 2026-09-03): WebKit through Playwright is
    // not Safari, and the Safari behaviours that would matter here are platform policies it cannot
    // reproduce. Kept wired so a later release can opt in via `npm run test:browser:webkit`, which
    // writes its own results file rather than overwriting the required engines' evidence.
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    // The production build is served under the policy published in docs/DEPLOYMENT.md, so the
    // browser suite qualifies that policy rather than merely describing it.
    env: {
      ACKWATCH_CSP: [
        "default-src 'none'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self'",
        "font-src 'self' data:",
        "img-src 'self' data:",
        'media-src data:',
        // Without this the web app manifest is blocked by `default-src 'none'` and the
        // application is silently not installable; nothing else about the page changes.
        "manifest-src 'self'",
        "connect-src 'self' https://homeserver.example",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
      ].join('; '),
    },
    command: 'npm run build && node tools/static-server.mjs dist 4173',
    port: 4173,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
