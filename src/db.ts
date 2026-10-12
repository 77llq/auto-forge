import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';

export function connectDatabase(connectionString: string, schema = 'public'): pg.Pool {
  if (!/^(public|af_test_[a-f0-9]{32})$/.test(schema)) throw new Error('Unsafe database schema');
  return new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 12,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
    statement_timeout: 15000, application_name: 'auto-forge-m1' });
}

export async function transaction<T>(pool: pg.Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function migrate(pool: pg.Pool): Promise<void> {
  const sql = await readFile(new URL('../db/migrations/001_foundation.sql', import.meta.url), 'utf8')
    .catch(async () => readFile(new URL('../../db/migrations/001_foundation.sql', import.meta.url), 'utf8'));
  const digest = createHash('sha256').update(sql).digest('hex');
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':auto-forge-migrations', 0))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const existing = await client.query<{ digest: string }>('SELECT digest FROM schema_migrations WHERE version=$1', ['001']);
    if (existing.rows[0]) {
      if (existing.rows[0].digest !== digest) throw new Error('Migration 001 checksum changed; add a new migration');
      return;
    }
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version,digest) VALUES ($1,$2)', ['001',digest]);
  });
}
