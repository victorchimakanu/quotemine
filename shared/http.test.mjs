import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createLocalServer } from './http.mjs';

test('local API rejects other origins, invalid JSON, and file escapes', async () => {
  const server = createLocalServer({ name: 'test', publicDir: new URL('../src/public/', import.meta.url), routes: { 'POST /api/echo': ({ body }) => body } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const good = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' });
    assert.deepEqual(await good.json(), { ok: true });
    const foreign = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}' });
    assert.equal(foreign.status, 403);
    const bad = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(bad.status, 400);
    const escaped = await fetch(`${base}/%2e%2e%2fpackage.json`);
    assert.equal(escaped.status, 403);
    const missing = await fetch(`${base}/api/missing`);
    assert.equal(missing.status, 404);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
