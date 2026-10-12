import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { contractCatalog, createDelivery, requirementContent, completeRequest, validateTraceability } from '../src/contracts.js';
import { canonicalJson, hash } from '../src/domain.js';
import { readConfig } from '../src/config.js';
import { content } from './helpers.js';

test('canonical hashes ignore object key ordering but preserve array order', () => {
  assert.equal(hash({ a: 1, b: ['x', 'y'] }), hash({ b: ['x', 'y'], a: 1 }));
  assert.notEqual(hash(['x', 'y']), hash(['y', 'x']));
  assert.equal(canonicalJson({ b: false, a: null }), '{"a":null,"b":false}');
  for (const invalid of [undefined, NaN, Infinity, new Date(), { bad: undefined }]) assert.throws(() => hash(invalid));
});
test('contracts reject unknown fields and real execution mode', () => {
  const valid = content(randomUUID());
  assert.ok(requirementContent.safeParse(valid).success);
  assert.ok(!requirementContent.safeParse({ ...valid, injectedCommand: 'run-shell' }).success);
  assert.ok(!createDelivery.safeParse({ requirementId: randomUUID(), requirementDigest: 'a'.repeat(64), mode: 'production' }).success);
  assert.ok(!completeRequest.safeParse({ lease: { token: randomUUID(), epoch: 1 }, outcome: 'succeeded',
    result: { kind: 'real', step: 'verify', inputDigest: 'a'.repeat(64), summary: 'PASS' } }).success);
});
test('traceability detects duplicate IDs, missing coverage and foreign references', () => {
  const valid = content(randomUUID());
  assert.deepEqual(validateTraceability(valid), []);
  valid.requirements.push({ id: 'R2', statement: 'Uncovered' }, valid.requirements[0]!);
  valid.acceptance[0]!.requirementIds.push('UNKNOWN');
  valid.acceptance.push(valid.acceptance[0]!);
  valid.sourceIds.push(valid.sourceIds[0]!);
  assert.equal(validateTraceability(valid).length, 6);
});
test('all public contracts generate machine-readable JSON schema', () => {
  const schemas = contractCatalog();
  assert.equal(Object.keys(schemas).length, 10);
  assert.match(JSON.stringify(schemas), /additionalProperties/);
});
test('configuration fails closed and never prints credentials in errors', () => {
  const secret = 's'.repeat(40);
  assert.throws(() => readConfig({ DATABASE_URL: 'not-a-url', CONTROL_API_TOKEN: secret, WORKER_API_TOKEN: 'w'.repeat(40) }),
    error => error instanceof Error && error.message.includes('DATABASE_URL') && !error.message.includes(secret));
  assert.throws(() => readConfig({ DATABASE_URL: 'postgresql://local/test', CONTROL_API_TOKEN: secret, WORKER_API_TOKEN: secret }));
});
