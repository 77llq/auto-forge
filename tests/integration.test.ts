import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDatabase, migrate } from '../src/db.js';
import { ForgeService } from '../src/service.js';
import { fixture, seeded, delivery, claim, success, drain, code, snapshot, content, key } from './helpers.js';

test('migration is repeatable and command/event/outbox commit atomically', async t => {
  const { service, pool } = await fixture(t);
  await migrate(pool);
  const commandKey = key();
  const results = await Promise.all(Array.from({ length: 8 }, () => service.createProject(commandKey, { name: 'One project' })));
  assert.ok(results.every(item => item.id === results[0]!.id));
  const counts = await pool.query('SELECT (SELECT count(*) FROM projects) AS projects,(SELECT count(*) FROM command_receipts) AS receipts,(SELECT count(*) FROM outbox) AS events');
  assert.deepEqual(counts.rows[0], { projects: '1', receipts: '1', events: '1' });
  await assert.rejects(service.createProject(commandKey, { name: 'Different' }), code('idempotency_conflict'));
  await assert.rejects(service.createSource(commandKey, results[0]!.id, { connector: 'fixture', externalId: 'x', sourceRevision: '1', text: 'x' }), code('idempotency_conflict'));
});

test('outbox write failure rolls back command state, event and receipt together', async t => {
  const { service, pool } = await fixture(t);
  await pool.query(`CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected_outbox_failure'; END; $$;
    CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION reject_outbox()`);
  const commandKey = key();
  await assert.rejects(service.createProject(commandKey, { name: 'Atomic project' }), /injected_outbox_failure/);
  const counts = await pool.query(`SELECT (SELECT count(*) FROM projects) AS projects,
    (SELECT count(*) FROM domain_events) AS events,(SELECT count(*) FROM command_receipts) AS receipts`);
  assert.deepEqual(counts.rows[0], { projects: '0', events: '0', receipts: '0' });
  await pool.query('DROP TRIGGER reject_outbox ON outbox; DROP FUNCTION reject_outbox()');
  assert.ok((await service.createProject(commandKey, { name: 'Atomic project' })).id);
});

test('migration refuses a changed checksum', async t => {
  const { pool } = await fixture(t);
  await pool.query("UPDATE schema_migrations SET digest='changed' WHERE version='001'");
  await assert.rejects(migrate(pool), /checksum changed/);
});

test('source versions dedupe across command keys and reject silent edits', async t => {
  const { service } = await fixture(t);
  const project = await service.createProject(key(), { name: 'P' });
  const input = { connector: 'fixture', externalId: 'x', sourceRevision: '1', text: 'Source' };
  const sources = await Promise.all(Array.from({ length: 6 }, () => service.createSource(key(), project.id, input)));
  assert.ok(sources.every(item => item.id === sources[0]!.id));
  await assert.rejects(service.createSource(key(), project.id, { ...input, text: 'Edited' }), code('source_revision_conflict'));
  assert.notEqual((await service.createSource(key(), project.id, { ...input, sourceRevision: '2', text: 'Edited' })).id, sources[0]!.id);
});

test('requirements enforce source ownership, traceability, readiness and pinned digest', async t => {
  const { service } = await fixture(t);
  const seed = await seeded(service, false);
  const other = await service.createProject(key(), { name: 'Other' });
  await assert.rejects(service.createRequirement(key(), other.id, content(seed.source.id)), code('source_project_mismatch'));
  await assert.rejects(service.createRequirement(key(), seed.project.id, { ...content(seed.source.id), acceptance: [
    { id: 'AC1', requirementIds: ['missing'], method: 'x', expected: 'y' },
  ] }), code('invalid_traceability'));
  const blocked = await service.createRequirement(key(), seed.project.id, { ...content(seed.source.id), blockingQuestions: ['Who approves?'] });
  await assert.rejects(service.readyRequirement(key(), blocked.id, { expectedRevision: 1 }), code('requirement_blocked'));
  const input = { requirementId: seed.requirement.id, requirementDigest: seed.requirement.digest, mode: 'simulation' };
  await assert.rejects(service.createDelivery(key(), seed.project.id, input), code('requirement_not_ready'));
  await service.readyRequirement(key(), seed.requirement.id, { expectedRevision: 1 });
  await assert.rejects(service.createDelivery(key(), seed.project.id, { ...input, requirementDigest: '0'.repeat(64) }), code('requirement_digest_conflict'));
  await assert.rejects(service.createDelivery(key(), other.id, input), code('requirement_not_found'));
});

test('concurrent workers receive exactly one lease; claim retry replays its receipt', async t => {
  const { service } = await fixture(t);
  await delivery(service);
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => service.claim(key(), `worker-${index}`, { capability: 'simulation' })));
  assert.equal(results.filter(item => item.job).length, 1);
  const another = await delivery(service);
  const commandKey = key();
  const first = await service.claim(commandKey, 'worker-a', { capability: 'simulation' });
  const replay = await service.claim(commandKey, 'worker-a', { capability: 'simulation' });
  assert.deepEqual(first, replay);
  assert.equal(first.job?.deliveryId, another.delivery.id);
});

test('four-stage recipe survives new service connections and finishes simulation only', async t => {
  const { service, pool, url, schema } = await fixture(t);
  const seed = await delivery(service);
  for (const expected of ['plan', 'implement', 'verify', 'review']) {
    const job = await claim(service);
    assert.equal(job.step, expected);
    const commandKey = key();
    await service.complete(commandKey, 'worker-a', job.id, success(job));
    assert.deepEqual(await service.complete(commandKey, 'worker-a', job.id, success(job)), { accepted: true });
    // Simulate a separate restarted dispatcher with no in-memory knowledge.
    const restartedPool = connectDatabase(url, schema);
    try { await drain(new ForgeService(restartedPool)); }
    finally { await restartedPool.end(); }
  }
  const result = await snapshot(service, seed.delivery.id);
  assert.equal(result.delivery.phase, 'simulation_completed');
  assert.equal(result.jobs.length, 4);
  assert.ok(result.jobs.every(job => job.status === 'succeeded'));
  assert.equal(result.attempts.length, 4);
  assert.equal(result.events.filter(event => event.type === 'delivery.simulation_completed').length, 1);
  assert.ok(!JSON.stringify(result).includes('lease_token'));
  assert.equal((await pool.query("SELECT count(*) FROM jobs WHERE result->>'kind'='simulation'")).rows[0].count, '4');
  await assert.rejects(service.control(key(), seed.delivery.id, { action: 'cancel', expectedRevision: result.delivery.revision }), code('delivery_terminal'));
});

test('outbox crash rolls back successor, inbox and ack; redelivery cannot duplicate work', async t => {
  const { service, pool } = await fixture(t);
  const seed = await delivery(service);
  const job = await claim(service);
  await drain(service);
  await service.complete(key(), 'worker-a', job.id, success(job));
  await assert.rejects(service.dispatchOne(() => { throw new Error('simulated_crash'); }), /simulated_crash/);
  assert.equal((await snapshot(service, seed.delivery.id)).jobs.length, 1);
  assert.equal((await pool.query("SELECT count(*) FROM inbox i JOIN domain_events e ON e.id=i.event_id WHERE e.type='job.succeeded'")).rows[0].count, '0');
  await drain(service);
  assert.equal((await snapshot(service, seed.delivery.id)).jobs.length, 2);
  await pool.query("UPDATE outbox SET delivered_at=NULL WHERE event_id IN (SELECT id FROM domain_events WHERE type='job.succeeded')");
  await Promise.all([drain(service), drain(service)]);
  assert.equal((await snapshot(service, seed.delivery.id)).jobs.length, 2);
});

test('expired leases are fenced and heartbeats cannot revive them', async t => {
  const { service, pool } = await fixture(t);
  const seed = await delivery(service);
  const first = await claim(service);
  await pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
  await assert.rejects(service.heartbeat('worker-a', first.id, { lease: first.lease }), code('lease_stale'));
  const second = await claim(service, 'worker-b');
  assert.equal(first.id, second.id);
  assert.equal(second.attempt, 2);
  assert.ok(second.lease.epoch > first.lease.epoch);
  await assert.rejects(service.complete(key(), 'worker-a', first.id, success(first)), code('lease_stale'));
  await assert.rejects(service.complete(key(), 'worker-a', second.id, success(second)), code('lease_stale'));
  await service.heartbeat('worker-b', second.id, { lease: second.lease });
  await service.complete(key(), 'worker-b', second.id, success(second));
  assert.deepEqual((await snapshot(service, seed.delivery.id)).attempts.map(item => item.status), ['expired', 'succeeded']);
});

test('pause revokes leases, resume requires revision, cancel rejects late results', async t => {
  const { service } = await fixture(t);
  const seed = await delivery(service);
  const first = await claim(service);
  const running = await snapshot(service, seed.delivery.id);
  await assert.rejects(service.control(key(), seed.delivery.id, { action: 'pause', expectedRevision: 1 }), code('revision_conflict'));
  const paused = await service.control(key(), seed.delivery.id, { action: 'pause', expectedRevision: running.delivery.revision });
  assert.equal((await service.claim(key(), 'worker-b', { capability: 'simulation' })).job, null);
  await assert.rejects(service.complete(key(), 'worker-a', first.id, success(first)), code('lease_stale'));
  await service.control(key(), seed.delivery.id, { action: 'resume', expectedRevision: paused.revision });
  const second = await claim(service);
  assert.equal(second.attempt, 2);
  const current = await snapshot(service, seed.delivery.id);
  const cancelKey = key();
  const command = { action: 'cancel', expectedRevision: current.delivery.revision };
  const cancelled = await service.control(cancelKey, seed.delivery.id, command);
  assert.deepEqual(await service.control(cancelKey, seed.delivery.id, command), cancelled);
  await assert.rejects(service.complete(key(), 'worker-a', second.id, success(second)), code('lease_stale'));
  await assert.rejects(service.heartbeat('worker-a', second.id, { lease: second.lease }), code('lease_stale'));
  assert.equal((await snapshot(service, seed.delivery.id)).delivery.phase, 'cancelled');
});

test('completion before cancellation cannot schedule a successor after cancellation', async t => {
  const { service } = await fixture(t);
  const seed = await delivery(service);
  const job = await claim(service);
  await service.complete(key(), 'worker-a', job.id, success(job));
  const current = await snapshot(service, seed.delivery.id);
  await service.control(key(), seed.delivery.id, { action: 'cancel', expectedRevision: current.delivery.revision });
  await drain(service);
  assert.equal((await snapshot(service, seed.delivery.id)).jobs.length, 1);
});

test('concurrent pause and completion serialize without deadlock or post-pause execution', async t => {
  const { service } = await fixture(t);
  for (let index = 0; index < 8; index++) {
    const seed = await delivery(service);
    const job = await claim(service);
    const current = await snapshot(service, seed.delivery.id);
    const [pause, complete] = await Promise.allSettled([
      service.control(key(), seed.delivery.id, { action: 'pause', expectedRevision: current.delivery.revision }),
      service.complete(key(), 'worker-a', job.id, success(job)),
    ]);
    assert.equal(pause.status, 'fulfilled');
    if (complete.status === 'rejected') assert.ok(code('lease_stale')(complete.reason));
    await drain(service);
    const final = await snapshot(service, seed.delivery.id);
    assert.equal(final.delivery.control_state, 'paused');
    assert.ok(final.jobs.every(item => item.status !== 'running'));
    assert.equal((await service.claim(key(), 'worker-a', { capability: 'simulation' })).job, null);
  }
});

test('retryable failures exhaust a finite attempt budget', async t => {
  const { service } = await fixture(t);
  const seed = await delivery(service);
  for (let index = 1; index <= 3; index++) {
    const job = await claim(service);
    assert.equal(job.attempt, index);
    await service.complete(key(), 'worker-a', job.id, { lease: job.lease, outcome: 'failed', reason: 'transient', retryable: true });
  }
  assert.equal((await service.claim(key(), 'worker-a', { capability: 'simulation' })).job, null);
  const final = await snapshot(service, seed.delivery.id);
  assert.equal(final.delivery.phase, 'failed');
  assert.equal(final.attempts.length, 3);
});

test('expired final lease terminates delivery instead of an infinite retry', async t => {
  const { service, pool } = await fixture(t, { maxAttempts: 1 });
  const seed = await delivery(service);
  const job = await claim(service);
  await pool.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
  assert.equal((await service.claim(key(), 'worker-a', { capability: 'simulation' })).job, null);
  const final = await snapshot(service, seed.delivery.id);
  assert.equal(final.delivery.phase, 'failed');
  assert.equal(final.attempts[0]!.status, 'expired');
});

test('nonretryable failure fails immediately and invalid result does not consume lease', async t => {
  const { service } = await fixture(t);
  const seed = await delivery(service);
  const job = await claim(service);
  const bad = success(job); bad.result.inputDigest = '0'.repeat(64);
  await assert.rejects(service.complete(key(), 'worker-a', job.id, bad), code('result_input_mismatch'));
  assert.equal((await snapshot(service, seed.delivery.id)).jobs[0]!.status, 'running');
  await service.complete(key(), 'worker-a', job.id, { lease: job.lease, outcome: 'failed', reason: 'policy_denied', retryable: false });
  assert.equal((await snapshot(service, seed.delivery.id)).delivery.phase, 'failed');
});

test('deadline sweeper bounds paused and abandoned deliveries without workers', async t => {
  const { service, pool } = await fixture(t);
  const seed = await delivery(service);
  await service.control(key(), seed.delivery.id, { action: 'pause', expectedRevision: 1 });
  await pool.query("UPDATE deliveries SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [seed.delivery.id]);
  assert.equal(await service.sweepDeadline(), true);
  assert.equal(await service.sweepDeadline(), false);
  assert.equal((await snapshot(service, seed.delivery.id)).delivery.phase, 'failed');
});

test('paused completed stage can be recorded but its successor cannot be claimed', async t => {
  const { service } = await fixture(t);
  const seed = await delivery(service);
  const job = await claim(service);
  await service.complete(key(), 'worker-a', job.id, success(job));
  const current = await snapshot(service, seed.delivery.id);
  await service.control(key(), seed.delivery.id, { action: 'pause', expectedRevision: current.delivery.revision });
  await drain(service);
  assert.equal((await snapshot(service, seed.delivery.id)).jobs[1]!.status, 'queued');
  assert.equal((await service.claim(key(), 'worker-a', { capability: 'simulation' })).job, null);
});
