import { readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { StateSnapshot } from './snapshot.ts';

/**
 * The sidecar's HTTP surface (issue #87): plain node:http, two routes —
 * static assets at `/`, one JSON snapshot at `/api/state`. No server
 * framework, no writes, no listener on the daemon (ADR 0002). Binding is
 * the caller's decision; localhost is the default security boundary.
 */

export interface DashboardHandle {
  server: Server;
  /** The bound port — the ephemeral one when 0 was requested. */
  port: number;
  close: () => Promise<void>;
}

export interface DashboardOptions {
  bind: string;
  port: number;
  /** Where the built frontend lives; null when it was never built. */
  assetsDir: string | null;
  snapshot: () => Promise<StateSnapshot>;
}

export function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const server = createServer((request, response) => {
    // Total guard: the ops view must survive any request — one malformed
    // URL taking the page down would be an availability bug (issue #87).
    route(options, request.url ?? '/', response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.bind, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function route(
  options: DashboardOptions,
  url: string,
  response: ServerResponse,
): Promise<void> {
  if (url.split('?')[0] === '/api/state') {
    try {
      const snapshot = await options.snapshot();
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(snapshot));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }
  serveStatic(options.assetsDir, url, response);
}

/** What Vite emits into dist/web — anything else 404s. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The page an install without built assets shows instead of an error. */
const UNBUILT_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Orchestrator dashboard</title>
<p>The dashboard frontend has not been built. In a dev checkout run
<code>npm run build:web</code>; an installed package ships it pre-built —
reinstall if this page persists. The JSON snapshot is live at
<a href="/api/state">/api/state</a>.</p>
`;

function serveStatic(assetsDir: string | null, url: string, response: ServerResponse): void {
  let path: string;
  try {
    path = decodeURIComponent(url.split('?')[0] ?? '/');
  } catch {
    // Malformed percent-encoding names no asset — and must never throw
    // past the handler.
    notFound(response);
    return;
  }
  if (assetsDir === null) {
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(UNBUILT_PAGE);
      return;
    }
    notFound(response);
    return;
  }
  const root = resolve(assetsDir);
  const target = normalize(join(root, path === '/' ? 'index.html' : path));
  const contentType = CONTENT_TYPES[extname(target)];
  if (!target.startsWith(root + sep) || contentType === undefined) {
    notFound(response);
    return;
  }
  let body: Buffer;
  try {
    body = readFileSync(target);
  } catch {
    notFound(response);
    return;
  }
  response.writeHead(200, {
    'content-type': contentType,
    // Vite hashes everything but index.html — the entry must revalidate so
    // a fresh deploy is picked up on the next poll, the rest can live long.
    'cache-control': target === join(root, 'index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  });
  response.end(body);
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
}
