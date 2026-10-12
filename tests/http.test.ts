import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/http.js';
import { ForgeClient } from '../src/client.js';
import { runSimulationOnce } from '../src/worker.js';
import { fixture, delivery, drain, snapshot, key } from './helpers.js';
import type { TestContext } from 'node:test';

const controlToken = 'control-test-token-'.repeat(3);
const workerToken = 'worker-test-token-'.repeat(3);
async function httpFixture(t: TestContext) {
  const data = await fixture(t);
  const server = createHttpServer(data.service, { controlToken, workerToken, workerId: 'worker-http' });
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
  assert.match(await page.text(), /SIMULATION/);
  assert.equal((await fetch(`${url}/v1/projects`)).status, 401);
  assert.equal((await fetch(`${url}/v1/projects`, { headers: { Authorization: `Bearer ${workerToken}` } })).status, 401);
  assert.equal((await fetch(`${url}/internal/v1/jobs/claim`, { method: 'POST', headers: { Authorization: `Bearer ${controlToken}` } })).status, 401);
  const contracts = await fetch(`${url}/v1/contracts`, { headers: { Authorization: `Bearer ${controlToken}` } });
  assert.equal(contracts.status, 200);
  const csrf = await fetch(`${url}/v1/projects`, { headers: { Authorization: `Bearer ${controlToken}`, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(csrf.status, 403);
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
