import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { appVersionDefine } from './tools/app-version.mjs';

export default defineConfig({
  base: './',
  define: appVersionDefine(new URL('./package.json', import.meta.url)),
  plugins: [react()],
  build: {
    sourcemap: false,
    target: 'es2022',
  },
});
