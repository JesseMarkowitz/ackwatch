import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/testing/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    outputFile: { json: './artifacts/reports/unit-results.json' },
    reporters: ['default', 'json'],
    restoreMocks: true,
  },
});
