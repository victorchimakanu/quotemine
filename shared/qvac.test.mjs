import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveCachedModel } from './qvac.mjs';

test('cached catalog weights are used locally only after size and checksum validation', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'qvac-cache-check-'));
  const bytes = Buffer.from('synthetic test weights');
  const registryPath = 'demo/example.gguf';
  const descriptor = { name: 'TEST', registryPath, src: 'registry://s3/demo/example.gguf', expectedSize: bytes.length, sha256Checksum: createHash('sha256').update(bytes).digest('hex') };
  const prefix = createHash('sha256').update(registryPath).digest('hex').slice(0, 16);
  const path = join(cacheDirectory, `${prefix}_example.gguf`);
  try {
    assert.equal(await resolveCachedModel(descriptor, { cacheDirectory }), descriptor);
    await writeFile(path, bytes);
    assert.equal(await resolveCachedModel(descriptor, { cacheDirectory }), path);
    await writeFile(path, Buffer.alloc(bytes.length, 0));
    await assert.rejects(resolveCachedModel(descriptor, { cacheDirectory }), /checksum/);
    await writeFile(path, Buffer.alloc(1));
    assert.equal(await resolveCachedModel(descriptor, { cacheDirectory }), descriptor);
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
});
