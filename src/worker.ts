import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, type ForgeClient } from './client.js';
import { claimedJob, type ClaimedJob } from './contracts.js';

export async function runSimulationOnce(client: ForgeClient): Promise<ClaimedJob | null> {
  const result = await client.request<{ job: unknown }>('/internal/v1/jobs/claim', { capability: 'simulation' });
  if (result.job === null) return null;
  const job = claimedJob.parse(result.job);
  await client.request(`/internal/v1/jobs/${job.id}/heartbeat`, { lease: job.lease });
  await client.request(`/internal/v1/jobs/${job.id}/complete`, {
    lease: job.lease, outcome: 'succeeded',
    result: { kind: 'simulation', step: job.step, inputDigest: job.inputDigest,
      summary: `SIMULATION ONLY: ${job.step} protocol completed; no model, repository, MCP, or real test was executed.` },
  });
  return job;
}

export async function runSimulationWorker(client: ForgeClient, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const job = await runSimulationOnce(client);
      if (job) console.log(JSON.stringify({ event: 'simulation.step_completed', jobId: job.id, step: job.step }));
    } catch (error) {
      console.error(JSON.stringify({ event: 'simulation.worker_error', code: error instanceof ApiError ? error.code : 'transport_error' }));
    }
    await delay(500, undefined, { signal }).catch(() => undefined);
  }
}
