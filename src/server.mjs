import { pathToFileURL } from 'node:url';
import { startLocalServer, HttpError } from '../shared/http.mjs';
import { loadDatasets, nextFriday, isoDate } from './core.mjs';
import { createQuoteRuntime } from './runtime.mjs';

export async function createRoutes(options = {}) {
  const datasets = options.datasets ?? await loadDatasets();
  const runtime = createQuoteRuntime({ ...options, datasets });
  const act = (callback) => async (context) => {
    try { return await callback(context); }
    catch (error) { throw new HttpError(error.status ?? 500, error.message, error.details); }
  };
  const routes = {
    'GET /api/status': async () => runtime.status(),
    'GET /api/catalog': async () => ({
      items: datasets.stock.items.map(({ sku, name }) => ({ sku, name })),
      zones: [...datasets.delivery.zones.map(({ id, name }) => ({ id, name })), { id: 'outside', name: 'Outside the demo area' }],
      defaultDate: nextFriday(), today: isoDate(), horizonDays: datasets.delivery.bookingHorizonDays,
      dataAsOf: { stock: datasets.stock.asOf, prices: datasets.prices.asOf, delivery: datasets.delivery.asOf }, synthetic: true
    }),
    'POST /api/model/load': act(async () => runtime.load()),
    'POST /api/model/unload': act(async () => runtime.unload()),
    'POST /api/quote': act(async ({ body }) => runtime.quote(body))
  };
  return { routes, runtime };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { routes, runtime } = await createRoutes();
  const server = startLocalServer({ name: 'QuoteMine', port: 4322, publicDir: new URL('./public/', import.meta.url), routes });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    try { await runtime.close(); process.exit(0); }
    catch (error) { console.error(`QuoteMine shutdown: ${error.message}`); process.exit(1); }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
