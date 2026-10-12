import { readConfig } from '../config.js';
import { ForgeClient } from '../client.js';
import { runSimulationWorker } from '../worker.js';
const config = readConfig();
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());
await runSimulationWorker(new ForgeClient(`http://127.0.0.1:${config.PORT}`, config.WORKER_API_TOKEN), stop.signal);
