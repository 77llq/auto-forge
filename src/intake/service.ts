import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { uuid, validateTraceability, type RequirementContent } from '../contracts.js';
import { command, emit } from '../commands.js';
import { hash, DomainError } from '../domain.js';
import * as c from './contracts.js';
import { currentSources } from './provenance.js';

type Scope = { id: string; project_id: string; connector: 'vanish' | 'confluence'; external_scope_id: string;
  label: string; enabled: boolean };
type Run = { id: string; scope_id: string; status: string; next_page: number; max_pages: number;
  start_page: number; pages_read: number; records_seen: number; new_versions: number };
type Item = { external_id: string; latest_source_id: string; latest_revision: string; latest_digest: string };
type Draft = { id: string; project_id: string; source_ids: string[]; content: RequirementContent;
  revision: number; status: string; requirement_id: string | null };

export class IntakeService {
  constructor(readonly pool: Pool) {}

  private async scope(db: PoolClient, scopeId: string): Promise<Scope> {
    const result = await db.query<Scope>('SELECT * FROM source_scopes WHERE id=$1 FOR UPDATE', [scopeId]);
    if (!result.rows[0]) throw new DomainError('scope_not_found', 404);
    return result.rows[0];
  }

  async registerScope(key: string, projectId: string, value: unknown) {
    uuid.parse(projectId);
    const input = c.registerScope.parse(value);
    return command(this.pool, 'control', key, `projects/${projectId}/scopes`, input, async db => {
      const project = await db.query('SELECT id FROM projects WHERE id=$1', [projectId]);
      if (!project.rowCount) throw new DomainError('project_not_found', 404);
      const id = randomUUID();
      await db.query(`INSERT INTO source_scopes(id,project_id,connector,external_scope_id,label)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,connector,external_scope_id) DO NOTHING`,
      [id, projectId, input.connector, input.externalScopeId, input.label]);
      const stored = (await db.query<Scope>(`SELECT * FROM source_scopes WHERE project_id=$1 AND connector=$2 AND external_scope_id=$3`,
        [projectId, input.connector, input.externalScopeId])).rows[0]!;
      if (stored.label !== input.label) throw new DomainError('scope_label_conflict');
      if (stored.id === id) await emit(db, null, 'scope.registered', { projectId, scopeId: id, connector: input.connector });
      return { id: stored.id, connector: stored.connector, externalScopeId: stored.external_scope_id,
        label: stored.label, enabled: stored.enabled };
    });
  }

  async setScopeState(key: string, scopeId: string, value: unknown) {
    uuid.parse(scopeId);
    const input = c.scopeState.parse(value);
    return command(this.pool, 'control', key, `scopes/${scopeId}/state`, input, async db => {
      const scope = await this.scope(db, scopeId);
      if (scope.enabled !== input.enabled) {
        await db.query('UPDATE source_scopes SET enabled=$2 WHERE id=$1', [scopeId, input.enabled]);
        if (!input.enabled) {
          const interrupted = await db.query<{ id: string }>(`UPDATE intake_runs SET status='failed',
            error_code='scope_disabled',finished_at=clock_timestamp() WHERE scope_id=$1 AND status='running' RETURNING id`, [scopeId]);
          for (const run of interrupted.rows) await emit(db, null, 'intake.failed', { scopeId, runId: run.id, reason: 'scope_disabled' });
        }
        await emit(db, null, input.enabled ? 'scope.enabled' : 'scope.disabled', { scopeId });
      }
      return { id: scopeId, enabled: input.enabled };
    });
  }

  async listScopes(projectId?: string) {
    if (projectId) uuid.parse(projectId);
    const result = await this.pool.query<Scope>(`SELECT * FROM source_scopes
      WHERE ($1::uuid IS NULL OR project_id=$1) ORDER BY created_at,id`, [projectId ?? null]);
    return result.rows.map(scope => ({ id: scope.id, projectId: scope.project_id, connector: scope.connector,
      externalScopeId: scope.external_scope_id, label: scope.label, enabled: scope.enabled }));
  }

  async startRun(key: string, scopeId: string, value: unknown) {
    uuid.parse(scopeId);
    const input = c.startRun.parse(value);
    return command(this.pool, 'intake', key, `scopes/${scopeId}/runs`, input, async db => {
      const scope = await this.scope(db, scopeId);
      if (!scope.enabled) throw new DomainError('scope_disabled');
      const interrupted = await db.query<{ id: string }>(`UPDATE intake_runs SET status='failed',
        error_code='interrupted',finished_at=clock_timestamp()
        WHERE scope_id=$1 AND status='running' RETURNING id`, [scopeId]);
      for (const run of interrupted.rows) await emit(db, null, 'intake.failed', { scopeId, runId: run.id, reason: 'interrupted' });
      const id = randomUUID();
      await db.query(`INSERT INTO intake_runs(id,scope_id,status,start_page,next_page,max_pages)
        VALUES($1,$2,'running',$3,$3,$4)`, [id, scopeId, input.startPage, input.maxPages]);
      await emit(db, null, 'intake.started', { scopeId, runId: id, startPage: input.startPage });
      return { id, scopeId, status: 'running', nextPage: input.startPage, maxPages: input.maxPages };
    });
  }

  private async markStale(db: PoolClient, sourceId: string): Promise<void> {
    const requirements = await db.query<{ id: string }>(`UPDATE requirements SET status='stale'
      WHERE status IN ('draft','ready') AND content->'sourceIds' ? $1 RETURNING id`, [sourceId]);
    await db.query(`UPDATE product_drafts SET status='stale',updated_at=clock_timestamp()
      WHERE status='review' AND $1::uuid=ANY(source_ids)`, [sourceId]);
    for (const requirement of requirements.rows) {
      await db.query('UPDATE deliveries SET input_stale=true WHERE requirement_id=$1', [requirement.id]);
      await emit(db, null, 'requirement.stale', { requirementId: requirement.id, sourceId });
    }
  }

  async ingestPage(key: string, runId: string, value: unknown) {
    uuid.parse(runId);
    const input = c.ingestPage.parse(value);
    if (new Set(input.records.map(record => record.externalId)).size !== input.records.length) {
      throw new DomainError('duplicate_external_id', 422);
    }
    return command(this.pool, 'intake', key, `runs/${runId}/pages`, input, async db => {
      const ref = (await db.query<{ scope_id: string }>('SELECT scope_id FROM intake_runs WHERE id=$1', [runId])).rows[0];
      if (!ref) throw new DomainError('intake_run_not_found', 404);
      const scope = await this.scope(db, ref.scope_id);
      const run = (await db.query<Run>('SELECT * FROM intake_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]!;
      if (!scope.enabled) throw new DomainError('scope_disabled');
      if (run.status !== 'running') throw new DomainError('intake_run_terminal');
      if (input.page !== run.next_page) throw new DomainError('intake_page_order');
      let newVersions = 0;
      for (const record of input.records) {
        const scopedExternalId = `${scope.id}:${record.externalId}`;
        const digest = hash({ connector: scope.connector, externalId: scopedExternalId,
          sourceRevision: record.sourceRevision, text: record.text });
        const item = (await db.query<Item>('SELECT * FROM scope_items WHERE scope_id=$1 AND external_id=$2 FOR UPDATE',
          [scope.id, record.externalId])).rows[0];
        if (item?.latest_revision === record.sourceRevision) {
          if (item.latest_digest !== digest) throw new DomainError('source_revision_conflict');
          await db.query('UPDATE scope_items SET last_seen_at=clock_timestamp() WHERE scope_id=$1 AND external_id=$2',
            [scope.id, record.externalId]);
          continue;
        }
        const existing = (await db.query<{ id: string; digest: string }>(`SELECT id,digest FROM sources
          WHERE project_id=$1 AND connector=$2 AND external_id=$3 AND source_revision=$4`,
        [scope.project_id, scope.connector, scopedExternalId, record.sourceRevision])).rows[0];
        if (existing) {
          if (existing.digest !== digest) throw new DomainError('source_revision_conflict');
          // An old version found during overlapping scans must not replace the latest one.
          continue;
        }
        const sourceId = randomUUID();
        await db.query(`INSERT INTO sources(id,project_id,connector,external_id,source_revision,content,digest)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [sourceId, scope.project_id, scope.connector,
          scopedExternalId, record.sourceRevision, record.text, digest]);
        if (item) {
          await this.markStale(db, item.latest_source_id);
          await db.query(`UPDATE scope_items SET latest_source_id=$3,latest_revision=$4,latest_digest=$5,
            last_seen_at=clock_timestamp() WHERE scope_id=$1 AND external_id=$2`,
          [scope.id, record.externalId, sourceId, record.sourceRevision, digest]);
        } else {
          await db.query(`INSERT INTO scope_items(scope_id,external_id,latest_source_id,latest_revision,latest_digest)
            VALUES($1,$2,$3,$4,$5)`, [scope.id, record.externalId, sourceId, record.sourceRevision, digest]);
        }
        newVersions++;
        await emit(db, null, 'source.ingested', { projectId: scope.project_id, sourceId, scopeId: scope.id });
      }
      const pagesRead = run.pages_read + 1;
      const status = !input.hasMore ? 'completed' : pagesRead >= run.max_pages ? 'partial' : 'running';
      await db.query(`UPDATE intake_runs SET next_page=$2,pages_read=$3,records_seen=records_seen+$4,
        new_versions=new_versions+$5,status=$6,finished_at=CASE WHEN $6='running' THEN NULL ELSE clock_timestamp() END
        WHERE id=$1`, [runId, input.page + 1, pagesRead, input.records.length, newVersions, status]);
      await db.query('INSERT INTO intake_pages(run_id,page,records_seen,has_more) VALUES($1,$2,$3,$4)',
        [runId, input.page, input.records.length, input.hasMore]);
      await emit(db, null, `intake.${status === 'running' ? 'page_ingested' : status}`, {
        scopeId: scope.id, runId, page: input.page, recordsSeen: input.records.length, newVersions });
      return { id: runId, status, nextPage: input.page + 1, pagesRead, newVersions: run.new_versions + newVersions };
    });
  }

  async failRun(key: string, runId: string, value: unknown) {
    uuid.parse(runId);
    const input = c.failRun.parse(value);
    return command(this.pool, 'intake', key, `runs/${runId}/fail`, input, async db => {
      const ref = (await db.query<{ scope_id: string }>('SELECT scope_id FROM intake_runs WHERE id=$1', [runId])).rows[0];
      if (!ref) throw new DomainError('intake_run_not_found', 404);
      await this.scope(db, ref.scope_id);
      const run = (await db.query<Run>('SELECT * FROM intake_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]!;
      if (run.status !== 'running') throw new DomainError('intake_run_terminal');
      await db.query("UPDATE intake_runs SET status='failed',error_code=$2,finished_at=clock_timestamp() WHERE id=$1", [runId, input.reason]);
      await emit(db, null, 'intake.failed', { runId, scopeId: ref.scope_id, reason: input.reason });
      return { id: runId, status: 'failed', reason: input.reason };
    });
  }

  async createDraft(key: string, projectId: string, value: unknown) {
    uuid.parse(projectId);
    const input = c.createDraft.parse(value);
    return command(this.pool, 'control', key, `projects/${projectId}/drafts`, input, async db => {
      const sources = await currentSources(db, projectId, input.sourceIds);
      const title = sources[0]!.content.split(/\r?\n/, 1)[0]!.trim().slice(0, 180) || '待确认需求';
      const content: RequirementContent = {
        schemaVersion: 1, title, sourceIds: input.sourceIds,
        scope: { in: ['待产品确认范围'], out: [] },
        requirements: [{ id: 'R1', statement: sources.map(source => source.content.slice(0, 1000)).join('\n\n').slice(0, 4000) }],
        acceptance: [{ id: 'AC1', requirementIds: ['R1'], method: '待产品补充验证方式', expected: '待产品补充预期结果' }],
        blockingQuestions: ['请确认需求范围、验收方法与预期结果。'],
      };
      const id = randomUUID();
      await db.query(`INSERT INTO product_drafts(id,project_id,source_ids,content,status)
        VALUES($1,$2,$3,$4,'review')`, [id, projectId, input.sourceIds, JSON.stringify(content)]);
      await emit(db, null, 'draft.created', { projectId, draftId: id, sourceIds: input.sourceIds });
      return { id, status: 'review', revision: 1, content };
    });
  }

  async reviseDraft(key: string, draftId: string, value: unknown) {
    uuid.parse(draftId);
    const input = c.reviseDraft.parse(value);
    if (validateTraceability(input.content).length) throw new DomainError('invalid_traceability', 422);
    return command(this.pool, 'control', key, `drafts/${draftId}/revise`, input, async db => {
      const ref = (await db.query<Draft>('SELECT * FROM product_drafts WHERE id=$1', [draftId])).rows[0];
      if (!ref) throw new DomainError('draft_not_found', 404);
      await currentSources(db, ref.project_id, ref.source_ids);
      const draft = (await db.query<Draft>('SELECT * FROM product_drafts WHERE id=$1 FOR UPDATE', [draftId])).rows[0]!;
      if (draft.status !== 'review') throw new DomainError('draft_not_editable');
      if (draft.revision !== input.expectedRevision) throw new DomainError('revision_conflict');
      if (JSON.stringify(draft.source_ids) !== JSON.stringify(input.content.sourceIds)) throw new DomainError('draft_source_change', 422);
      await db.query(`UPDATE product_drafts SET content=$2,revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
        [draftId, JSON.stringify(input.content)]);
      await emit(db, null, 'draft.revised', { draftId, revision: draft.revision + 1 });
      return { id: draftId, status: 'review', revision: draft.revision + 1, content: input.content };
    });
  }

  async approveDraft(key: string, draftId: string, value: unknown) {
    uuid.parse(draftId);
    const input = c.approveDraft.parse(value);
    return command(this.pool, 'control', key, `drafts/${draftId}/approve`, input, async db => {
      const ref = (await db.query<Draft>('SELECT * FROM product_drafts WHERE id=$1', [draftId])).rows[0];
      if (!ref) throw new DomainError('draft_not_found', 404);
      await currentSources(db, ref.project_id, ref.source_ids);
      const draft = (await db.query<Draft>('SELECT * FROM product_drafts WHERE id=$1 FOR UPDATE', [draftId])).rows[0]!;
      if (draft.status !== 'review') throw new DomainError('draft_not_editable');
      if (draft.revision !== input.expectedRevision) throw new DomainError('revision_conflict');
      if (draft.content.blockingQuestions.length) throw new DomainError('draft_blocked');
      if (validateTraceability(draft.content).length) throw new DomainError('invalid_traceability', 422);
      const requirementId = randomUUID();
      const digest = hash(draft.content);
      await db.query(`INSERT INTO requirements(id,project_id,revision,content,digest,status,ready_at)
        VALUES($1,$2,1,$3,$4,'ready',clock_timestamp())`,
      [requirementId, draft.project_id, JSON.stringify(draft.content), digest]);
      await db.query(`UPDATE product_drafts SET status='approved',requirement_id=$2,updated_at=clock_timestamp()
        WHERE id=$1`, [draftId, requirementId]);
      await emit(db, null, 'draft.approved', { draftId, requirementId, digest });
      return { id: draftId, requirementId, digest, status: 'approved' };
    });
  }

  async projectSnapshot(projectId: string) {
    uuid.parse(projectId);
    const result = await this.pool.query<{ snapshot: unknown }>(`SELECT jsonb_build_object(
      'scopes',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at) FROM source_scopes s WHERE s.project_id=$1),'[]'::jsonb),
      'runs',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.started_at DESC) FROM intake_runs r
        JOIN source_scopes s ON s.id=r.scope_id WHERE s.project_id=$1),'[]'::jsonb),
      'drafts',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at DESC) FROM product_drafts d
        WHERE d.project_id=$1),'[]'::jsonb),
      'latestSources',COALESCE((SELECT jsonb_agg(i.latest_source_id) FROM scope_items i
        JOIN source_scopes s ON s.id=i.scope_id WHERE s.project_id=$1),'[]'::jsonb)) AS snapshot`, [projectId]);
    return result.rows[0]!.snapshot;
  }
}
