import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/scale',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  // Seeding ten thousand activities through the real transactional write path is deliberately slow;
  // the measurement is the point, so the budget is generous and the assertions are on the numbers.
  timeout: 900_000,
  reporter: [['list'], ['json', { outputFile: 'artifacts/reports/scale-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4176',
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    contextOptions: { reducedMotion: 'reduce' },
    deviceScaleFactor: 1,
  },
  projects: [{ name: 'scale' }],
  webServer: {
    command: 'node tools/static-server.mjs dist-benchmark 4176',
    port: 4176,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
