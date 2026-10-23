import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

let sdkPromise;
const verifiedModels = new Map();

export function getSdk() {
  sdkPromise ??= import('@qvac/sdk').catch((error) => {
    sdkPromise = undefined;
    throw error;
  });
  return sdkPromise;
}

export function errorDetails(error) {
  const causes = [];
  let current = error;
  for (let count = 0; current && count < 5; count += 1) {
    causes.push({ message: String(current.message ?? current), code: current.code ?? null });
    current = current.cause;
  }
  return causes;
}

export async function resolveCachedModel(descriptor, { cacheDirectory = join(homedir(), '.qvac', 'models') } = {}) {
  if (!descriptor?.registryPath || !descriptor.sha256Checksum || !Number.isSafeInteger(descriptor.expectedSize)) return descriptor;
  const prefix = createHash('sha256').update(descriptor.registryPath).digest('hex').slice(0, 16);
  const path = join(cacheDirectory, `${prefix}_${basename(descriptor.registryPath)}`);
  let info;
  try { info = await stat(path); } catch { return descriptor; }
  if (!info.isFile() || info.size !== descriptor.expectedSize) return descriptor;
  const version = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${descriptor.sha256Checksum}`;
  if (verifiedModels.get(path) === version) return path;
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest('hex') !== descriptor.sha256Checksum) throw new Error(`The cached ${descriptor.name ?? 'model'} failed its checksum. Remove its incomplete cache file and download it again.`);
  verifiedModels.set(path, version);
  return path;
}
