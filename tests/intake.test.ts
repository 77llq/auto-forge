import test from 'node:test';
import assert from 'node:assert/strict';
import { IntakeService } from '../src/intake/service.js';
import { fixture, key, content, code } from './helpers.js';

async function scoped(t: Parameters<typeof fixture>[0]) {
  const { service, pool } = await fixture(t);
  const intake = new IntakeService(pool);
  const project = await service.createProject(key(), { name: 'Synthetic intake project' });
  const scope = await intake.registerScope(key(), project.id,
    { connector: 'vanish', externalScopeId: 'fixture-session', label: 'Fixture session' });
  return { service, pool, intake, project, scope };
}

test('scope registration is allowlisted, idempotent and disable fences active runs', async t => {
  const { intake, project, scope } = await scoped(t);
  const duplicate = await intake.registerScope(key(), project.id,
    { connector: 'vanish', externalScopeId: 'fixture-session', label: 'Fixture session' });
  assert.equal(duplicate.id, scope.id);
  await assert.rejects(intake.registerScope(key(), project.id,
    { connector: 'vanish', externalScopeId: 'fixture-session', label: 'Different' }), code('scope_label_conflict'));
  await assert.rejects(intake.registerScope(key(), project.id,
    { connector: 'confluence', externalScopeId: 'https://example.com/page', label: 'Bad' }));
  const run = await intake.startRun(key(), scope.id, { startPage: 1, maxPages: 2 });
  await intake.setScopeState(key(), scope.id, { enabled: false });
  await assert.rejects(intake.ingestPage(key(), run.id, { page: 1, records: [], hasMore: false }), code('scope_disabled'));
  await assert.rejects(intake.startRun(key(), scope.id, {}), code('scope_disabled'));
  await intake.setScopeState(key(), scope.id, { enabled: true });
  assert.equal((await intake.listScopes(project.id))[0]!.enabled, true);
});

test('overlapping scans dedupe versions and expose partial coverage', async t => {
  const { intake, scope, pool } = await scoped(t);
  const input = { page: 1, records: [{ externalId: 'message-1', sourceRevision: '1', text: 'Build a review page' }], hasMore: true };
  const first = await intake.startRun(key(), scope.id, { maxPages: 1 });
  const pageKey = key();
  const result = await intake.ingestPage(pageKey, first.id, input);
  assert.equal(result.status, 'partial');
  assert.deepEqual(await intake.ingestPage(pageKey, first.id, input), result);
  await assert.rejects(intake.ingestPage(key(), first.id, input), code('intake_run_terminal'));
  const second = await intake.startRun(key(), scope.id, { maxPages: 3 });
  const overlap = await intake.ingestPage(key(), second.id, input);
  assert.equal(overlap.newVersions, 0);
  const final = await intake.ingestPage(key(), second.id, { page: 2, records: [], hasMore: false });
  assert.equal(final.status, 'completed');
  assert.equal((await pool.query("SELECT count(*) FROM sources WHERE connector='vanish'")).rows[0].count, '1');
  assert.equal((await pool.query('SELECT count(*) FROM intake_pages')).rows[0].count, '3');
});

test('source change stales drafts and ready requirements without rewriting pinned deliveries', async t => {
  const { service, intake, scope, project, pool } = await scoped(t);
  const first = await intake.startRun(key(), scope.id, {});
  await intake.ingestPage(key(), first.id, { page: 1, records: [{ externalId: 'm1', sourceRevision: '1', text: 'Build alerts' }], hasMore: false });
  const sourceId = (await pool.query<{ id: string }>("SELECT id FROM sources WHERE connector='vanish'")).rows[0]!.id;
  const draft = await intake.createDraft(key(), project.id, { sourceIds: [sourceId] });
  await assert.rejects(intake.approveDraft(key(), draft.id, { expectedRevision: 1 }), code('draft_blocked'));
  const readyContent = { ...content(sourceId), blockingQuestions: [] };
  await assert.rejects(intake.reviseDraft(key(), draft.id, { expectedRevision: 2, content: readyContent }), code('revision_conflict'));
  const revised = await intake.reviseDraft(key(), draft.id, { expectedRevision: 1, content: readyContent });
  assert.equal(revised.revision, 2);
  const approved = await intake.approveDraft(key(), draft.id, { expectedRevision: 2 });
  const delivery = await service.createDelivery(key(), project.id,
    { requirementId: approved.requirementId, requirementDigest: approved.digest, mode: 'simulation' });
  const pending = await intake.createDraft(key(), project.id, { sourceIds: [sourceId] });
  const second = await intake.startRun(key(), scope.id, {});
  await intake.ingestPage(key(), second.id, { page: 1, records: [{ externalId: 'm1', sourceRevision: '2', text: 'Build alerts with mute control' }], hasMore: false });
  assert.equal((await pool.query<{ status: string }>('SELECT status FROM requirements WHERE id=$1', [approved.requirementId])).rows[0]!.status, 'stale');
  assert.equal((await pool.query<{ status: string }>('SELECT status FROM product_drafts WHERE id=$1', [pending.id])).rows[0]!.status, 'stale');
  assert.equal((await pool.query<{ input_stale: boolean }>('SELECT input_stale FROM deliveries WHERE id=$1', [delivery.id])).rows[0]!.input_stale, true);
  await assert.rejects(service.createDelivery(key(), project.id,
    { requirementId: approved.requirementId, requirementDigest: approved.digest, mode: 'simulation' }), code('requirement_not_ready'));
  await assert.rejects(intake.approveDraft(key(), pending.id, { expectedRevision: 1 }), code('source_stale_or_foreign'));
  await assert.rejects(service.createRequirement(key(), project.id, content(sourceId)), code('source_stale_or_foreign'));
  const newId = (await pool.query<{ latest_source_id: string }>('SELECT latest_source_id FROM scope_items')).rows[0]!.latest_source_id;
  assert.ok((await intake.createDraft(key(), project.id, { sourceIds: [newId] })).id);
});

test('approval racing a source update cannot leave an old ready requirement', async t => {
  const { intake, scope, project, pool } = await scoped(t);
  const first = await intake.startRun(key(), scope.id, {});
  await intake.ingestPage(key(), first.id, { page: 1,
    records: [{ externalId: 'm-race', sourceRevision: '1', text: 'Synthetic initial request' }], hasMore: false });
  const sourceId = (await pool.query<{ id: string }>("SELECT id FROM sources WHERE connector='vanish'")).rows[0]!.id;
  const draft = await intake.createDraft(key(), project.id, { sourceIds: [sourceId] });
  await intake.reviseDraft(key(), draft.id, { expectedRevision: 1, content: content(sourceId) });
  const second = await intake.startRun(key(), scope.id, {});
  const [approval, update] = await Promise.allSettled([
    intake.approveDraft(key(), draft.id, { expectedRevision: 2 }),
    intake.ingestPage(key(), second.id, { page: 1,
      records: [{ externalId: 'm-race', sourceRevision: '2', text: 'Synthetic revised request' }], hasMore: false }),
  ]);
  assert.equal(update.status, 'fulfilled');
  if (approval.status === 'rejected') assert.match(String(approval.reason), /source_stale_or_foreign|draft_not_editable/);
  assert.equal((await pool.query("SELECT count(*) FROM requirements WHERE status='ready'")).rows[0].count, '0');
});

test('outbox failure rolls back page, source, scope pointer and command receipt', async t => {
  const { intake, scope, pool } = await scoped(t);
  const run = await intake.startRun(key(), scope.id, {});
  await pool.query(`CREATE FUNCTION reject_new_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.type='source.ingested' THEN RAISE EXCEPTION 'injected_outbox_failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER reject_new_source BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION reject_new_source()`);
  const pageKey = key();
  const input = { page: 1, records: [{ externalId: 'm1', sourceRevision: '1', text: 'Synthetic request' }], hasMore: false };
  await assert.rejects(intake.ingestPage(pageKey, run.id, input), /injected_outbox_failure/);
  assert.equal((await pool.query('SELECT count(*) FROM scope_items')).rows[0].count, '0');
  assert.equal((await pool.query('SELECT count(*) FROM intake_pages')).rows[0].count, '0');
  await pool.query('DROP TRIGGER reject_new_source ON domain_events; DROP FUNCTION reject_new_source()');
  assert.equal((await intake.ingestPage(pageKey, run.id, input)).status, 'completed');
});

test('failed scans are explicit and do not erase already captured pages', async t => {
  const { intake, scope, pool } = await scoped(t);
  const run = await intake.startRun(key(), scope.id, { maxPages: 3 });
  await intake.ingestPage(key(), run.id, { page: 1, records: [{ externalId: 'm1', sourceRevision: '1', text: 'Synthetic request' }], hasMore: true });
  await assert.rejects(intake.ingestPage(key(), run.id, { page: 3, records: [], hasMore: false }), code('intake_page_order'));
  await intake.failRun(key(), run.id, { reason: 'access_denied' });
  assert.equal((await pool.query('SELECT count(*) FROM scope_items')).rows[0].count, '1');
  const status = (await intake.projectSnapshot((await pool.query<{ project_id: string }>(
    'SELECT project_id FROM source_scopes WHERE id=$1', [scope.id])).rows[0]!.project_id)) as { runs: Array<{ status: string; error_code: string }> };
  assert.equal(status.runs[0]!.error_code, 'access_denied');
});
