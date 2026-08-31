import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/visual',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'artifacts/reports/visual-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    contextOptions: { reducedMotion: 'reduce' },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'visual' }],
  webServer: {
    command: 'node tools/static-server.mjs dist-catalog 4174',
    port: 4174,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
