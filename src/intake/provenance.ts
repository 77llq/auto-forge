import type { PoolClient } from 'pg';
import { DomainError } from '../domain.js';

export async function currentSources(db: PoolClient, projectId: string, sourceIds: string[]) {
  if (new Set(sourceIds).size !== sourceIds.length) throw new DomainError('duplicate_source_id', 422);
  const found = await db.query<{ id: string; content: string; connector: string; external_id: string }>(
    'SELECT id,content,connector,external_id FROM sources WHERE project_id=$1 AND id=ANY($2::uuid[])',
    [projectId, sourceIds]);
  if (found.rowCount !== sourceIds.length) throw new DomainError('source_project_mismatch', 422);
  const externalIds = found.rows.filter(source => ['vanish','confluence'].includes(source.connector))
    .map(source => source.external_id);
  if (externalIds.length) {
    const current = await db.query<{ external_id: string; latest_source_id: string }>(`SELECT
      i.scope_id::text || ':' || i.external_id AS external_id,i.latest_source_id
      FROM scope_items i WHERE i.scope_id::text || ':' || i.external_id=ANY($1::text[])
      FOR SHARE OF i`, [externalIds]);
    if (current.rowCount !== externalIds.length || current.rows.some(item =>
      !found.rows.some(source => source.external_id === item.external_id && source.id === item.latest_source_id))) {
      throw new DomainError('source_stale_or_foreign', 422);
    }
  }
  return sourceIds.map(id => found.rows.find(row => row.id === id)!);
}
