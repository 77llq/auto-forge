import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import * as c from './contracts.js';
import { DomainError, finalPhases, hash } from './domain.js';
import { transaction } from './db.js';
import { command, emit } from './commands.js';
import { currentSources } from './intake/provenance.js';

type Delivery = {
  id: string; phase: string; control_state: string; revision: number;
  max_attempts: number; input_digest: string; deadline_at: Date;
};
type Job = {
  id: string; delivery_id: string; step_index: number; step: c.Step; status: string;
  attempt_count: number; epoch: number; worker_id: string | null;
  lease_token: string | null; lease_expires_at: Date | null;
};
type Requirement = {
  id: string; project_id: string; status: string; revision: number;
  content: c.RequirementContent; digest: string;
};
type Source = { id: string; digest: string };
export type ServiceOptions = { leaseMs?: number; deadlineMs?: number; maxAttempts?: number };

// PostgreSQL is the authority for both state and time. No in-memory workflow state.
export class ForgeService {
  readonly leaseMs: number;
  readonly deadlineMs: number;
  readonly maxAttempts: number;
  constructor(readonly pool: Pool, options: ServiceOptions = {}) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.deadlineMs = options.deadlineMs ?? 3_600_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    if (![this.leaseMs, this.deadlineMs, this.maxAttempts].every(Number.isSafeInteger)
      || this.leaseMs < 1 || this.deadlineMs < 1 || this.maxAttempts < 1 || this.maxAttempts > 3) {
      throw new Error('Invalid service limits');
    }
  }

  private command<T>(actor: string, key: string, route: string, input: unknown,
    apply: (db: PoolClient) => Promise<T>): Promise<T> {
    return command(this.pool, actor, key, route, input, apply);
  }

  private async emit(db: PoolClient, deliveryId: string | null, type: string, payload: unknown): Promise<void> {
    await emit(db, deliveryId, type, payload);
  }

  private async projectExists(db: PoolClient, projectId: string): Promise<void> {
    if (!(await db.query('SELECT id FROM projects WHERE id=$1', [projectId])).rowCount) {
      throw new DomainError('project_not_found', 404);
    }
  }

  async createProject(key: string, value: unknown): Promise<{ id: string; name: string }> {
    const input = c.createProject.parse(value);
    return this.command('control', key, 'projects.create', input, async db => {
      const project = { id: randomUUID(), name: input.name };
      await db.query('INSERT INTO projects(id,name) VALUES($1,$2)', [project.id, project.name]);
      await this.emit(db, null, 'project.created', { projectId: project.id });
      return project;
    });
  }

  async createSource(key: string, projectId: string, value: unknown): Promise<Source> {
    c.uuid.parse(projectId);
    const input = c.createSource.parse(value);
    return this.command('control', key, `projects/${projectId}/sources`, input, async db => {
      await this.projectExists(db, projectId);
      const digest = hash(input);
      const id = randomUUID();
      await db.query(`INSERT INTO sources(id,project_id,connector,external_id,source_revision,content,digest)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(project_id,connector,external_id,source_revision) DO NOTHING`,
      [id, projectId, input.connector, input.externalId, input.sourceRevision, input.text, digest]);
      const stored = (await db.query<Source>(`SELECT id,digest FROM sources
        WHERE project_id=$1 AND connector=$2 AND external_id=$3 AND source_revision=$4`,
      [projectId, input.connector, input.externalId, input.sourceRevision])).rows[0]!;
      if (stored.digest !== digest) throw new DomainError('source_revision_conflict');
      if (stored.id === id) await this.emit(db, null, 'source.ingested', { projectId, sourceId: id });
      return stored;
    });
  }

  async createRequirement(key: string, projectId: string, value: unknown): Promise<{ id: string; digest: string; revision: 1; status: 'draft' }> {
    c.uuid.parse(projectId);
    const input = c.requirementContent.parse(value);
    if (c.validateTraceability(input).length) throw new DomainError('invalid_traceability', 422);
    return this.command('control', key, `projects/${projectId}/requirements`, input, async db => {
      await this.projectExists(db, projectId);
      await currentSources(db, projectId, input.sourceIds);
      const result = { id: randomUUID(), digest: hash(input), revision: 1 as const, status: 'draft' as const };
      await db.query(`INSERT INTO requirements(id,project_id,revision,content,digest,status)
        VALUES($1,$2,1,$3,$4,'draft')`, [result.id, projectId, JSON.stringify(input), result.digest]);
      await this.emit(db, null, 'requirement.created', { projectId, requirementId: result.id, digest: result.digest });
      return result;
    });
  }

  async readyRequirement(key: string, requirementId: string, value: unknown): Promise<{ id: string; status: 'ready' }> {
    c.uuid.parse(requirementId);
    const input = c.readyRequirement.parse(value);
    return this.command('control', key, `requirements/${requirementId}/ready`, input, async db => {
      const requirement = (await db.query<Requirement>('SELECT * FROM requirements WHERE id=$1 FOR UPDATE', [requirementId])).rows[0];
      if (!requirement) throw new DomainError('requirement_not_found', 404);
      if (requirement.revision !== input.expectedRevision) throw new DomainError('revision_conflict');
      if (requirement.status === 'stale') throw new DomainError('requirement_stale');
      if (requirement.content.blockingQuestions.length) throw new DomainError('requirement_blocked');
      if (requirement.status !== 'ready') {
        await db.query("UPDATE requirements SET status='ready',ready_at=clock_timestamp() WHERE id=$1", [requirementId]);
        await this.emit(db, null, 'requirement.ready', { requirementId, digest: requirement.digest });
      }
      return { id: requirementId, status: 'ready' };
    });
  }

  private async insertJob(db: PoolClient, deliveryId: string, index: number): Promise<void> {
    const step = c.steps[index];
    if (!step) throw new Error('Unknown recipe step');
    const id = randomUUID();
    const inserted = await db.query(`INSERT INTO jobs(id,delivery_id,step_index,step,status)
      VALUES($1,$2,$3,$4,'queued') ON CONFLICT(delivery_id,step_index) DO NOTHING`, [id, deliveryId, index, step]);
    if (inserted.rowCount) await this.emit(db, deliveryId, 'job.queued', { jobId: id, step });
  }

  async createDelivery(key: string, projectId: string, value: unknown): Promise<{ id: string; phase: 'queued'; revision: 1 }> {
    c.uuid.parse(projectId);
    const input = c.createDelivery.parse(value);
    return this.command('control', key, `projects/${projectId}/deliveries`, input, async db => {
      const requirement = (await db.query<Requirement>('SELECT * FROM requirements WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [input.requirementId, projectId])).rows[0];
      if (!requirement) throw new DomainError('requirement_not_found', 404);
      if (requirement.status !== 'ready') throw new DomainError('requirement_not_ready');
      if (requirement.digest !== input.requirementDigest) throw new DomainError('requirement_digest_conflict');
      const result = { id: randomUUID(), phase: 'queued' as const, revision: 1 as const };
      await db.query(`INSERT INTO deliveries(id,project_id,requirement_id,input_digest,mode,phase,control_state,max_attempts,deadline_at)
        VALUES($1,$2,$3,$4,'simulation','queued','active',$5,clock_timestamp()+$6*interval '1 millisecond')`,
      [result.id, projectId, input.requirementId, input.requirementDigest, this.maxAttempts, this.deadlineMs]);
      await this.emit(db, result.id, 'delivery.created', { requirementId: input.requirementId, digest: input.requirementDigest, mode: input.mode });
      await this.insertJob(db, result.id, 0);
      return result;
    });
  }

  private async lockDelivery(db: PoolClient, id: string): Promise<Delivery> {
    const delivery = (await db.query<Delivery>('SELECT * FROM deliveries WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!delivery) throw new DomainError('delivery_not_found', 404);
    return delivery;
  }

  // All paths lock delivery before job, avoiding control/completion/claim deadlocks.
  private async lockJob(db: PoolClient, id: string): Promise<{ delivery: Delivery; job: Job }> {
    const ref = (await db.query<{ delivery_id: string }>('SELECT delivery_id FROM jobs WHERE id=$1', [id])).rows[0];
    if (!ref) throw new DomainError('job_not_found', 404);
    const delivery = await this.lockDelivery(db, ref.delivery_id);
    const job = (await db.query<Job>('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [id])).rows[0]!;
    return { delivery, job };
  }

  private async now(db: PoolClient): Promise<Date> {
    return (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  }

  private async stopDelivery(db: PoolClient, deliveryId: string, phase: 'failed' | 'cancelled', reason: string): Promise<void> {
    await db.query(`UPDATE attempts SET status=$2,reason=$3,finished_at=clock_timestamp()
      WHERE status='running' AND job_id IN (SELECT id FROM jobs WHERE delivery_id=$1)`,
    [deliveryId, phase === 'failed' ? 'failed' : 'cancelled', reason]);
    await db.query(`UPDATE jobs SET status=$2,epoch=epoch+1,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE delivery_id=$1 AND status IN ('queued','running')`, [deliveryId, phase]);
    await db.query('UPDATE deliveries SET phase=$2,revision=revision+1 WHERE id=$1', [deliveryId, phase]);
    await this.emit(db, deliveryId, `delivery.${phase}`, { reason });
  }

  async control(key: string, deliveryId: string, value: unknown): Promise<{ id: string; revision: number; phase: string; controlState: string }> {
    c.uuid.parse(deliveryId);
    const input = c.controlDelivery.parse(value);
    return this.command('control', key, `deliveries/${deliveryId}/control`, input, async db => {
      const delivery = await this.lockDelivery(db, deliveryId);
      if (delivery.revision !== input.expectedRevision) throw new DomainError('revision_conflict');
      if (finalPhases.has(delivery.phase)) throw new DomainError('delivery_terminal');
      if (input.action === 'cancel') {
        await this.stopDelivery(db, deliveryId, 'cancelled', 'user_cancelled');
        return { id: deliveryId, revision: delivery.revision + 1, phase: 'cancelled', controlState: delivery.control_state };
      }
      const next = input.action === 'pause' ? 'paused' : 'active';
      if (next === delivery.control_state) throw new DomainError('invalid_control_transition');
      if (next === 'paused') {
        await db.query(`UPDATE attempts SET status='cancelled',reason='paused',finished_at=clock_timestamp()
          WHERE status='running' AND job_id IN (SELECT id FROM jobs WHERE delivery_id=$1)`, [deliveryId]);
        await db.query(`UPDATE jobs SET status='queued',epoch=epoch+1,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL
          WHERE delivery_id=$1 AND status='running'`, [deliveryId]);
      }
      await db.query('UPDATE deliveries SET control_state=$2,revision=revision+1 WHERE id=$1', [deliveryId, next]);
      await this.emit(db, deliveryId, `delivery.${input.action === 'pause' ? 'paused' : 'resumed'}`, {});
      return { id: deliveryId, revision: delivery.revision + 1, phase: delivery.phase, controlState: next };
    });
  }

  async claim(key: string, workerId: string, value: unknown): Promise<{ job: c.ClaimedJob | null }> {
    c.key.parse(workerId);
    const input = c.claimRequest.parse(value);
    return this.command(`worker:${workerId}`, key, 'jobs.claim', input, async db => {
      // Serialize within each delivery; different deliveries can be claimed in parallel.
      const delivery = (await db.query<Delivery>(`SELECT d.* FROM deliveries d
        WHERE d.control_state='active' AND d.phase IN ('queued','running')
        AND EXISTS(SELECT 1 FROM jobs j WHERE j.delivery_id=d.id AND
          (j.status='queued' OR (j.status='running' AND j.lease_expires_at<=clock_timestamp())))
        ORDER BY d.created_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1`)).rows[0];
      if (!delivery) return { job: null };
      if (delivery.deadline_at <= await this.now(db)) {
        await this.stopDelivery(db, delivery.id, 'failed', 'deadline_exceeded');
        return { job: null };
      }
      const job = (await db.query<Job>(`SELECT * FROM jobs WHERE delivery_id=$1
        AND (status='queued' OR (status='running' AND lease_expires_at<=clock_timestamp()))
        ORDER BY step_index FOR UPDATE LIMIT 1`, [delivery.id])).rows[0];
      // The candidate EXISTS can become stale while another claimant holds the
      // delivery lock. Recheck the job under that lock before using it.
      if (!job) return { job: null };
      if (job.status === 'running') {
        await db.query("UPDATE attempts SET status='expired',reason='lease_expired',finished_at=clock_timestamp() WHERE job_id=$1 AND status='running'", [job.id]);
        await this.emit(db, delivery.id, 'job.lease_expired', { jobId: job.id, epoch: job.epoch });
      }
      if (job.attempt_count >= delivery.max_attempts) {
        await this.stopDelivery(db, delivery.id, 'failed', 'attempts_exhausted');
        return { job: null };
      }
      const token = randomUUID();
      const updated = (await db.query<Job>(`UPDATE jobs SET status='running',attempt_count=attempt_count+1,epoch=epoch+1,
        worker_id=$2,lease_token=$3,lease_expires_at=LEAST($4,clock_timestamp()+$5*interval '1 millisecond')
        WHERE id=$1 RETURNING *`, [job.id, workerId, token, delivery.deadline_at, this.leaseMs])).rows[0]!;
      await db.query(`INSERT INTO attempts(id,job_id,ordinal,epoch,worker_id,status) VALUES($1,$2,$3,$4,$5,'running')`,
        [randomUUID(), job.id, updated.attempt_count, updated.epoch, workerId]);
      if (delivery.phase === 'queued') await db.query("UPDATE deliveries SET phase='running',revision=revision+1 WHERE id=$1", [delivery.id]);
      await this.emit(db, delivery.id, 'job.claimed', { jobId: job.id, workerId, epoch: updated.epoch, attempt: updated.attempt_count });
      return { job: { id: job.id, deliveryId: delivery.id, step: job.step, inputDigest: delivery.input_digest,
        attempt: updated.attempt_count, lease: { token, epoch: updated.epoch }, leaseExpiresAt: updated.lease_expires_at!.toISOString() } };
    });
  }

  private async checkLease(db: PoolClient, delivery: Delivery, job: Job, workerId: string, lease: c.Lease): Promise<void> {
    const now = await this.now(db);
    if (finalPhases.has(delivery.phase) || delivery.control_state !== 'active' || delivery.deadline_at <= now
      || job.status !== 'running' || job.worker_id !== workerId || job.epoch !== lease.epoch
      || job.lease_token !== lease.token || !job.lease_expires_at || job.lease_expires_at <= now) {
      throw new DomainError('lease_stale');
    }
  }

  async heartbeat(workerId: string, jobId: string, value: unknown): Promise<{ leaseExpiresAt: string }> {
    c.uuid.parse(jobId);
    const { lease } = c.heartbeatRequest.parse(value);
    return transaction(this.pool, async db => {
      const { delivery, job } = await this.lockJob(db, jobId);
      await this.checkLease(db, delivery, job, workerId, lease);
      const updated = await db.query<{ lease_expires_at: Date }>(`UPDATE jobs SET
        lease_expires_at=LEAST($2,clock_timestamp()+$3*interval '1 millisecond') WHERE id=$1 RETURNING lease_expires_at`,
      [jobId, delivery.deadline_at, this.leaseMs]);
      return { leaseExpiresAt: updated.rows[0]!.lease_expires_at.toISOString() };
    });
  }

  async complete(key: string, workerId: string, jobId: string, value: unknown): Promise<{ accepted: true }> {
    c.uuid.parse(jobId);
    const input = c.completeRequest.parse(value);
    return this.command(`worker:${workerId}`, key, `jobs/${jobId}/complete`, input, async db => {
      const { delivery, job } = await this.lockJob(db, jobId);
      await this.checkLease(db, delivery, job, workerId, input.lease);
      if (input.outcome === 'succeeded' && (input.result.step !== job.step || input.result.inputDigest !== delivery.input_digest)) {
        throw new DomainError('result_input_mismatch', 422);
      }
      const retry = input.outcome === 'failed' && input.retryable && job.attempt_count < delivery.max_attempts;
      const status = input.outcome === 'succeeded' ? 'succeeded' : retry ? 'queued' : 'failed';
      await db.query(`UPDATE jobs SET status=$2,result=$3,worker_id=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1`,
        [jobId, status, input.outcome === 'succeeded' ? JSON.stringify(input.result) : null]);
      await db.query(`UPDATE attempts SET status=$2,reason=$3,finished_at=clock_timestamp() WHERE job_id=$1 AND status='running'`,
        [jobId, input.outcome, input.outcome === 'failed' ? input.reason : null]);
      await this.emit(db, delivery.id, input.outcome === 'succeeded' ? 'job.succeeded' : retry ? 'job.retry_queued' : 'job.failed',
        { jobId, step: job.step, epoch: job.epoch, ...(input.outcome === 'failed' ? { reason: input.reason } : {}) });
      if (status === 'failed') await this.stopDelivery(db, delivery.id, 'failed', input.outcome === 'failed' ? input.reason : 'job_failed');
      return { accepted: true };
    });
  }

  // Transactional outbox and inbox. The hook enables deterministic crash injection in tests only.
  async dispatchOne(beforeCommit?: () => void): Promise<boolean> {
    return transaction(this.pool, async db => {
      const event = (await db.query<{ id: string; delivery_id: string | null; type: string; payload: { jobId?: string } }>(
        `SELECT e.id,e.delivery_id,e.type,e.payload FROM outbox o JOIN domain_events e ON e.id=o.event_id
         WHERE o.delivered_at IS NULL ORDER BY e.sequence FOR UPDATE OF o SKIP LOCKED LIMIT 1`)).rows[0];
      if (!event) return false;
      const inserted = await db.query(`INSERT INTO inbox(consumer,event_id) VALUES('recipe-v1',$1) ON CONFLICT DO NOTHING`, [event.id]);
      if (inserted.rowCount && event.type === 'job.succeeded' && event.delivery_id && event.payload.jobId) {
        const delivery = await this.lockDelivery(db, event.delivery_id);
        const job = (await db.query<Job>('SELECT * FROM jobs WHERE id=$1 AND delivery_id=$2', [event.payload.jobId, delivery.id])).rows[0];
        if (job?.status === 'succeeded' && !finalPhases.has(delivery.phase)) {
          if (delivery.deadline_at <= await this.now(db)) {
            await this.stopDelivery(db, delivery.id, 'failed', 'deadline_exceeded');
          } else if (job.step_index < c.steps.length - 1) {
            await this.insertJob(db, delivery.id, job.step_index + 1);
          } else {
            await db.query("UPDATE deliveries SET phase='simulation_completed',revision=revision+1 WHERE id=$1", [delivery.id]);
            await this.emit(db, delivery.id, 'delivery.simulation_completed', { mode: 'simulation', realExecution: false });
          }
        }
      }
      await db.query('UPDATE outbox SET delivered_at=clock_timestamp() WHERE event_id=$1', [event.id]);
      beforeCommit?.();
      return true;
    });
  }

  async sweepDeadline(): Promise<boolean> {
    return transaction(this.pool, async db => {
      const expired = (await db.query<{ id: string }>(`SELECT id FROM deliveries
        WHERE phase IN ('queued','running') AND deadline_at<=clock_timestamp()
        ORDER BY deadline_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (!expired) return false;
      await this.stopDelivery(db, expired.id, 'failed', 'deadline_exceeded');
      return true;
    });
  }

  async listProjects(): Promise<unknown[]> {
    return (await this.pool.query('SELECT id,name,created_at FROM projects ORDER BY created_at DESC LIMIT 100')).rows;
  }

  async projectSnapshot(projectId: string): Promise<unknown> {
    c.uuid.parse(projectId);
    const result = await this.pool.query<{ snapshot: unknown }>(`SELECT jsonb_build_object(
      'project',to_jsonb(p),
      'sources',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at) FROM sources s WHERE s.project_id=p.id),'[]'::jsonb),
      'requirements',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at) FROM requirements r WHERE r.project_id=p.id),'[]'::jsonb),
      'deliveries',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at) FROM deliveries d WHERE d.project_id=p.id),'[]'::jsonb)
      ) AS snapshot FROM projects p WHERE p.id=$1`, [projectId]);
    if (!result.rows[0]) throw new DomainError('project_not_found', 404);
    return result.rows[0].snapshot;
  }

  async deliverySnapshot(deliveryId: string): Promise<unknown> {
    c.uuid.parse(deliveryId);
    // A single SQL statement gives a coherent snapshot. Lease tokens are never exposed.
    const result = await this.pool.query<{ snapshot: unknown }>(`SELECT jsonb_build_object(
      'delivery',to_jsonb(d),
      'jobs',COALESCE((SELECT jsonb_agg(to_jsonb(j)-'lease_token' ORDER BY j.step_index) FROM jobs j WHERE j.delivery_id=d.id),'[]'::jsonb),
      'attempts',COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.started_at) FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE j.delivery_id=d.id),'[]'::jsonb),
      'events',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.sequence) FROM domain_events e WHERE e.delivery_id=d.id),'[]'::jsonb)
      ) AS snapshot FROM deliveries d WHERE d.id=$1`, [deliveryId]);
    if (!result.rows[0]) throw new DomainError('delivery_not_found', 404);
    return result.rows[0].snapshot;
  }
}
