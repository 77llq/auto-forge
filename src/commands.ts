import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { key } from './contracts.js';
import { transaction } from './db.js';
import { DomainError, hash } from './domain.js';

export function command<T>(pool: Pool, actor: string, commandKey: string, route: string, input: unknown,
  apply: (db: PoolClient) => Promise<T>): Promise<T> {
  key.parse(commandKey);
  const receiptKey = `${actor}:${commandKey}`;
  const digest = hash({ actor, route, input });
  return transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [receiptKey]);
    const previous = await db.query<{ request_digest: string; response: T }>(
      'SELECT request_digest,response FROM command_receipts WHERE key=$1', [receiptKey]);
    if (previous.rows[0]) {
      if (previous.rows[0].request_digest !== digest) throw new DomainError('idempotency_conflict');
      return previous.rows[0].response;
    }
    const response = JSON.parse(JSON.stringify(await apply(db))) as T;
    await db.query('INSERT INTO command_receipts(key,request_digest,response) VALUES($1,$2,$3)',
      [receiptKey, digest, JSON.stringify(response)]);
    return response;
  });
}

export async function emit(db: PoolClient, deliveryId: string | null, type: string, payload: unknown): Promise<void> {
  const eventId = randomUUID();
  await db.query('INSERT INTO domain_events(id,delivery_id,type,payload) VALUES($1,$2,$3,$4)',
    [eventId, deliveryId, type, JSON.stringify(payload)]);
  await db.query('INSERT INTO outbox(event_id) VALUES($1)', [eventId]);
}
