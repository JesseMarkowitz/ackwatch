import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { appVersionDefine } from './tools/app-version.mjs';
import { instructionsStylesheet, readInstructions } from './tools/build-instructions.mjs';

/**
 * Injects the deployment Content Security Policy as a `<meta http-equiv>` tag when
 * `ACKWATCH_META_CSP` is set at build time.
 *
 * The policy in docs/DEPLOYMENT.md is a response header, and a header is the better delivery: it
 * covers the document before a byte of it is parsed and it supports every directive. But some
 * static hosts — Start9 Pages among them — serve files without any way to add headers, and the
 * choice there is between a meta policy and no policy at all. A meta policy is the weaker of the
 * two and much stronger than nothing.
 *
 * `frame-ancestors` is dropped rather than passed through: it is ignored when delivered by meta,
 * and leaving it in makes every browser log an error about it. Anti-framing on a host like that
 * has to come from somewhere else, which docs/DEPLOYMENT.md says plainly.
 */
function metaContentSecurityPolicy(): Plugin {
  return {
    name: 'ackwatch-meta-csp',
    transformIndexHtml(html) {
      const policy = process.env.ACKWATCH_META_CSP;
      if (!policy) return html;
      const directives = policy
        .split(';')
        .map((directive) => directive.trim())
        .filter(Boolean)
        .filter((directive) => !/^(frame-ancestors|report-uri|sandbox)\b/i.test(directive));
      const content = directives.join('; ').replace(/"/g, '&quot;');
      const tag = `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
      // Placed immediately after the charset declaration, which has to stay within the first 1024
      // bytes of the document, and before everything the policy governs.
      const charset = /<meta charset=["'][^"']*["']\s*\/?>/i.exec(html);
      if (charset) {
        const at = charset.index + charset[0].length;
        return `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`;
      }
      return html.replace('<head>', `<head>\n    ${tag}`);
    },
  };
}

/**
 * Serves the instructions page during development.
 *
 * The page is generated at build time, so in `vite dev` the link found no file — and Vite's SPA
 * fallback answered with index.html, so clicking Instructions silently reopened the application
 * with a 200. A 404 would at least have said something was wrong. This renders the same page the
 * build writes, from the file on disk, so an edit to instructions.md shows up on reload.
 */
function devInstructions(): Plugin {
  return {
    name: 'ackwatch-dev-instructions',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? '').split('?')[0];
        if (url === '/instructions.html') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(readInstructions());
          return;
        }
        if (url === '/instructions.css') {
          response.setHeader('Content-Type', 'text/css; charset=utf-8');
          response.end(instructionsStylesheet);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: './',
  define: appVersionDefine(new URL('./package.json', import.meta.url)),
  plugins: [react(), metaContentSecurityPolicy(), devInstructions()],
  build: {
    sourcemap: false,
    target: 'es2022',
  },
});
