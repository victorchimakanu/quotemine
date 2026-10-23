import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function parseBody(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return undefined;
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Send JSON using application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'This request is larger than 1 MB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'The request contains invalid JSON.'); }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': mime['.json'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value));
}

export function createLocalServer({ name, publicDir, routes = {} }) {
  const root = resolve(publicDir instanceof URL ? fileURLToPath(publicDir) : publicDir);
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new HttpError(403, 'This app accepts localhost requests only.');
      const url = new URL(req.url, `http://${host}`);
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (origin.protocol !== 'http:' || origin.host !== host) throw new HttpError(403, 'Open this app on its own localhost address.');
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler) {
        const body = await parseBody(req);
        const result = await handler({ body, url, req, request: req, res });
        if (!res.writableEnded) json(res, 200, result ?? {});
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(404, 'No matching action.');
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'No matching action.');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { throw new HttpError(400, 'Invalid URL.'); }
      const target = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (target !== root && !target.startsWith(`${root}${sep}`)) throw new HttpError(403, 'Invalid file path.');
      let info;
      try { info = await stat(target); } catch { throw new HttpError(404, 'File not found.'); }
      if (!info.isFile()) throw new HttpError(404, 'File not found.');
      const bytes = await readFile(target);
      res.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.writableEnded) return;
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error(`[${name}]`, error);
      json(res, status, { error: String(error.message ?? error), ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) });
    }
  });
  server.requestTimeout = 300_000;
  server.headersTimeout = 30_000;
  return server;
}

export function startLocalServer(options) {
  const server = createLocalServer(options);
  const port = Number(process.env.PORT ?? options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  server.listen(port, '127.0.0.1', () => console.log(`${options.name}: http://127.0.0.1:${server.address().port}`));
  server.on('error', (error) => { console.error(`${options.name}: ${error.message}`); process.exitCode = 1; });
  return server;
}
