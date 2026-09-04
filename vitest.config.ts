import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { appVersionDefine } from './tools/app-version.mjs';

export default defineConfig({
  plugins: [react()],
  define: appVersionDefine(new URL('./package.json', import.meta.url)),
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testing/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    outputFile: { json: './artifacts/reports/unit-results.json' },
    reporters: ['default', 'json'],
    restoreMocks: true,
  },
});
