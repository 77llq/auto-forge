import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../config.js';
import { connectDatabase, migrate } from '../db.js';
import { ForgeService } from '../service.js';
import { createHttpServer } from '../http.js';

const config = readConfig();
const pool = connectDatabase(config.DATABASE_URL);
pool.on('error', () => console.error(JSON.stringify({ event: 'database.pool_error' })));
try { await migrate(pool); } catch { await pool.end(); throw new Error('Database migration failed; check database availability and migration history'); }
const service = new ForgeService(pool);
const server = createHttpServer(service, { controlToken: config.CONTROL_API_TOKEN, workerToken: config.WORKER_API_TOKEN,
  ...(config.INTAKE_API_TOKEN ? { intakeToken: config.INTAKE_API_TOKEN } : {}), workerId: config.WORKER_ID });
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.PORT, '127.0.0.1', resolve);
}).catch(async () => { await pool.end(); throw new Error('Could not bind local API port'); });
console.log(`Auto Forge M2 (intake + simulation): http://127.0.0.1:${config.PORT}`);
const scheduler = (async () => {
  while (!stop.signal.aborted) {
    try {
      await service.sweepDeadline();
      // Bounded batches keep deadline sweeps and shutdown responsive.
      for (let count = 0; count < 100 && !stop.signal.aborted; count++) if (!await service.dispatchOne()) break;
    } catch { console.error(JSON.stringify({ event: 'scheduler.retry_pending' })); }
    await delay(250, undefined, { signal: stop.signal }).catch(() => undefined);
  }
})();
await new Promise<void>(resolve => {
  if (stop.signal.aborted) resolve();
  else stop.signal.addEventListener('abort', () => resolve(), { once: true });
});
await new Promise<void>(resolve => server.close(() => resolve()));
await scheduler;
await pool.end();
