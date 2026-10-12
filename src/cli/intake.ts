import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../config.js';
import { ApiError, ForgeClient } from '../client.js';
import { connectReadTools, readMcpConfig, type McpConfig } from '../intake/mcp.js';
import { ProviderError, readPage } from '../intake/provider.js';

type Scope = { id: string; connector: 'vanish' | 'confluence'; externalScopeId: string; enabled: boolean };
type Run = { id: string; status: string; nextPage: number; maxPages: number; newVersions: number };
const config = readConfig();
if (!config.INTAKE_API_TOKEN) throw new Error('INTAKE_API_TOKEN is missing; run npm run setup:intake');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--once' && arg !== '--watch')) throw new Error('Usage: npm run intake:once or npm run intake:watch');
const watch = args.includes('--watch');
const mcp = await readMcpConfig(process.env.MCP_CONNECTORS_CONFIG ?? '.mcp-connectors.local.json');
const api = new ForgeClient(`http://127.0.0.1:${config.PORT}`, config.INTAKE_API_TOKEN);
const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
process.once('SIGTERM', () => stop.abort());

async function scan(scope: Scope, spec: NonNullable<McpConfig['vanish']>) {
  const provider = await connectReadTools(spec, scope.connector);
  let run: Run | undefined;
  try {
    run = await api.request<Run>(`/internal/v1/intake/scopes/${scope.id}/runs`, { startPage: 1, maxPages: 5 });
    for (let page = 1; page <= 5 && !stop.signal.aborted; page++) {
      const result = await readPage(provider, scope, page);
      run = await api.request<Run>(`/internal/v1/intake/runs/${run.id}/pages`, { page, ...result });
      if (run.status !== 'running') break;
    }
    console.log(JSON.stringify({ event: 'intake.scan_finished', scopeId: scope.id,
      status: run?.status ?? 'stopped', newVersions: run?.newVersions ?? 0 }));
  } catch (error) {
    const reason = error instanceof ProviderError ? error.code
      : error instanceof ApiError ? 'ingestion_rejected' : 'transport_error';
    if (run) await api.request(`/internal/v1/intake/runs/${run.id}/fail`, { reason }).catch(() => undefined);
    console.error(JSON.stringify({ event: 'intake.scan_failed', scopeId: scope.id, reason }));
  } finally { await provider.close(); }
}

do {
  try {
    const { scopes } = await api.request<{ scopes: Scope[] }>('/internal/v1/intake/scopes');
    for (const scope of scopes.filter(item => item.enabled)) {
      if (stop.signal.aborted) break;
      const spec = mcp[scope.connector];
      if (spec) await scan(scope, spec);
      else console.error(JSON.stringify({ event: 'intake.connector_unconfigured', scopeId: scope.id, connector: scope.connector }));
    }
  } catch { console.error(JSON.stringify({ event: 'intake.control_unavailable' })); }
  if (watch) await delay(60_000, undefined, { signal: stop.signal }).catch(() => undefined);
} while (watch && !stop.signal.aborted);
