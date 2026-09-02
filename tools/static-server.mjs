import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const [rootArgument, portArgument] = process.argv.slice(2);

if (!rootArgument || !portArgument) {
  throw new Error('Usage: node tools/static-server.mjs <root> <port>');
}

const root = resolve(rootArgument);
const port = Number.parseInt(portArgument, 10);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, `http://127.0.0.1:${port}`);
  const mountedPath = url.pathname.startsWith('/ackwatch/')
    ? url.pathname.slice('/ackwatch'.length)
    : url.pathname;
  const relativePath = mountedPath === '/' ? 'index.html' : mountedPath.replace(/^\/+/, '');
  const candidate = normalize(join(root, relativePath));

  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return undefined;
  }

  return existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(root, 'index.html');
}

const server = createServer((request, response) => {
  const filePath = resolveRequestPath(request.url ?? '/');

  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`AckWatch static server: ${root} on http://127.0.0.1:${port}\n`);
});
