import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/http.js';
import { ForgeClient } from '../src/client.js';
import { runSimulationOnce } from '../src/worker.js';
import { fixture, delivery, drain, snapshot, key } from './helpers.js';
import type { TestContext } from 'node:test';

const controlToken = 'control-test-token-'.repeat(3);
const workerToken = 'worker-test-token-'.repeat(3);
const intakeToken = 'intake-test-token-'.repeat(3);
async function httpFixture(t: TestContext, intakeEnabled = false) {
  const data = await fixture(t);
  const server = createHttpServer(data.service, { controlToken, workerToken, workerId: 'worker-http',
    ...(intakeEnabled ? { intakeToken } : {}) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  return { ...data, url, server };
}

test('HTTP health, local console and distinct token permissions', async t => {
  const { url } = await httpFixture(t);
  assert.equal((await fetch(`${url}/health`)).status, 200);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.match(await page.text(), /SOURCE INTAKE/);
  assert.equal((await fetch(`${url}/v1/projects`)).status, 401);
  assert.equal((await fetch(`${url}/v1/projects`, { headers: { Authorization: `Bearer ${workerToken}` } })).status, 401);
  assert.equal((await fetch(`${url}/internal/v1/jobs/claim`, { method: 'POST', headers: { Authorization: `Bearer ${controlToken}` } })).status, 401);
  const contracts = await fetch(`${url}/v1/contracts`, { headers: { Authorization: `Bearer ${controlToken}` } });
  assert.equal(contracts.status, 200);
  const csrf = await fetch(`${url}/v1/projects`, { headers: { Authorization: `Bearer ${controlToken}`, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(csrf.status, 403);
});

test('intake API has its own read/ingest credential and control cannot impersonate it', async t => {
  const { url } = await httpFixture(t, true);
  const control = new ForgeClient(url, controlToken);
  const intake = new ForgeClient(url, intakeToken);
  const worker = new ForgeClient(url, workerToken);
  const project = await control.request<{ id: string }>('/v1/projects', { name: 'HTTP intake' });
  const scope = await control.request<{ id: string }>(`/v1/projects/${project.id}/scopes`,
    { connector: 'confluence', externalScopeId: '12345', label: 'Fixture page' });
  await assert.rejects(control.request('/internal/v1/intake/scopes'), error =>
    error instanceof Error && error.message.includes('401'));
  await assert.rejects(worker.request('/internal/v1/intake/scopes'), error =>
    error instanceof Error && error.message.includes('401'));
  await assert.rejects(intake.request(`/v1/projects/${project.id}/intake`), error =>
    error instanceof Error && error.message.includes('401'));
  const scopes = await intake.request<{ scopes: Array<{ id: string }> }>('/internal/v1/intake/scopes');
  assert.equal(scopes.scopes[0]!.id, scope.id);
  const run = await intake.request<{ id: string }>(`/internal/v1/intake/scopes/${scope.id}/runs`, {});
  await intake.request(`/internal/v1/intake/runs/${run.id}/pages`, {
    page: 1, records: [{ externalId: '12345', sourceRevision: '1', text: 'Synthetic PRD' }], hasMore: false,
  });
  const view = await control.request<{ runs: Array<{ status: string }> }>(`/v1/projects/${project.id}/intake`);
  assert.equal(view.runs[0]!.status, 'completed');
  await assert.rejects(worker.request(`/internal/v1/intake/runs/${run.id}/pages`, {
    page: 2, records: [], hasMore: false,
  }), error => error instanceof Error && error.message.includes('401'));
});

test('HTTP validates JSON, body size, idempotency and unexpected properties', async t => {
  const { url } = await httpFixture(t);
  const headers: Record<string, string> = { Authorization: `Bearer ${controlToken}`, 'Idempotency-Key': key(), 'Content-Type': 'application/json' };
  const post = (body: string, custom = headers) => fetch(`${url}/v1/projects`, { method: 'POST', headers: custom, body });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('{}', { ...headers, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('{"name":"x"}', { ...headers, 'Idempotency-Key': '' })).status, 400);
  assert.equal((await post(JSON.stringify({ name: 'x', shell: 'touch /tmp/not-authorized' }))).status, 400);
  assert.equal((await post(JSON.stringify({ name: 'x'.repeat(70000) }))).status, 413);
  const first = await post('{"name":"HTTP project"}');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), await (await post('{"name":"HTTP project"}')).json());
  assert.equal((await post('{"name":"Changed"}')).status, 409);
  const invalid = await fetch(`${url}/v1/deliveries/invalid-id`, { headers });
  assert.equal(invalid.status, 400);
});

test('HTTP worker completes persisted simulation recipe end to end', async t => {
  const { url, service } = await httpFixture(t);
  const seed = await delivery(service);
  const worker = new ForgeClient(url, workerToken);
  for (let i = 0; i < 4; i++) {
    assert.ok(await runSimulationOnce(worker));
    await drain(service);
  }
  assert.equal(await runSimulationOnce(worker), null);
  const result = await snapshot(service, seed.delivery.id);
  assert.equal(result.delivery.phase, 'simulation_completed');
  const control = new ForgeClient(url, controlToken);
  const view = await control.request(`/v1/deliveries/${seed.delivery.id}`);
  assert.ok(!JSON.stringify(view).includes('lease_token'));
});
