import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { connectDatabase, migrate } from '../src/db.js';
import { ForgeService, type ServiceOptions } from '../src/service.js';
import type { ClaimedJob, RequirementContent } from '../src/contracts.js';
import { DomainError } from '../src/domain.js';

export const key = () => randomUUID();
export async function fixture(t: TestContext, options: ServiceOptions = {}) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must target a dedicated database ending in _test');
  const schema = `af_test_${randomUUID().replaceAll('-', '')}`;
  const admin = connectDatabase(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = connectDatabase(url, schema);
  t.after(async () => {
    await pool.end();
    // This literal schema was generated in this test; never drop databases or public.
    assert.match(schema, /^af_test_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await migrate(pool);
  const service = new ForgeService(pool, options);
  return { service, pool, schema, url };
}

export function content(sourceId: string): RequirementContent {
  return { schemaVersion: 1, title: 'Simulation fixture', sourceIds: [sourceId],
    scope: { in: ['Verify durable orchestration'], out: ['Real code execution'] },
    requirements: [{ id: 'R1', statement: 'Run all simulation stages' }],
    acceptance: [{ id: 'AC1', requirementIds: ['R1'], method: 'Inspect job records', expected: 'Four simulated stages' }],
    blockingQuestions: [] };
}

export async function seeded(service: ForgeService, ready = true) {
  const project = await service.createProject(key(), { name: 'Test project' });
  const source = await service.createSource(key(), project.id, { connector: 'fixture', externalId: 'fixture', sourceRevision: '1', text: 'Test source' });
  const requirement = await service.createRequirement(key(), project.id, content(source.id));
  if (ready) await service.readyRequirement(key(), requirement.id, { expectedRevision: 1 });
  return { project, source, requirement };
}

export async function delivery(service: ForgeService) {
  const seed = await seeded(service);
  const result = await service.createDelivery(key(), seed.project.id, { requirementId: seed.requirement.id, requirementDigest: seed.requirement.digest, mode: 'simulation' });
  return { ...seed, delivery: result };
}

export async function claim(service: ForgeService, worker = 'worker-a'): Promise<ClaimedJob> {
  const result = await service.claim(key(), worker, { capability: 'simulation' });
  assert.ok(result.job, 'Expected a claimable job');
  return result.job;
}

export const success = (job: ClaimedJob) => ({ lease: job.lease, outcome: 'succeeded' as const,
  result: { kind: 'simulation' as const, step: job.step, inputDigest: job.inputDigest, summary: 'Simulation only; no real tests executed.' } });
export async function drain(service: ForgeService) {
  for (let i = 0; i < 1000; i++) if (!await service.dispatchOne()) return;
  throw new Error('Dispatcher did not drain within bounded test loop');
}

export const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;

export type Snapshot = {
  delivery: { id: string; phase: string; control_state: string; revision: number };
  jobs: Array<{ id: string; status: string; step: string; attempt_count: number; epoch: number }>;
  attempts: Array<{ status: string; reason: string }>;
  events: Array<{ id: string; type: string }>;
};
export const snapshot = async (service: ForgeService, id: string) => await service.deliverySnapshot(id) as Snapshot;
