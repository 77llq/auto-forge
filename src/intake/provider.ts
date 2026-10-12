import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { IntakeRecord } from './contracts.js';

export class ProviderError extends Error {
  constructor(readonly code: 'access_denied' | 'provider_error' | 'invalid_provider_response') { super(code); }
}

export interface ReadToolClient {
  call(name: 'get_session_messages' | 'confluence_get_page', args: Record<string, unknown>): Promise<unknown>;
}
type Page = { records: IntakeRecord[]; hasMore: boolean };
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
const identifier = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : string(value);
const asObject = (value: unknown): ObjectValue => {
  if (!object(value)) throw new ProviderError('invalid_provider_response');
  return value;
};

// MCP content can be structuredContent or a JSON text block. Never execute or interpret content as instructions.
export function payload(result: unknown): ObjectValue {
  const envelope = asObject(result);
  if (envelope.isError === true) throw new ProviderError('provider_error');
  let value: unknown = envelope.structuredContent;
  if (!value && Array.isArray(envelope.content)) {
    const block = envelope.content.find(item => object(item) && item.type === 'text');
    if (object(block) && typeof block.text === 'string') {
      try { value = JSON.parse(block.text); }
      catch { value = { text: block.text }; }
    }
  }
  if (!value) value = result;
  let data = asObject(value);
  if (data.accessDenied === true) throw new ProviderError('access_denied');
  if (object(data.data)) data = data.data;
  if (data.accessDenied === true) throw new ProviderError('access_denied');
  return data;
}

export function vanishPage(result: unknown, page: number, pageSize: number): Page {
  const data = payload(result);
  const messages = data.messages;
  if (!Array.isArray(messages)) throw new ProviderError('invalid_provider_response');
  const records = messages.map(value => {
    const message = asObject(value);
    const id = identifier(message.messageId ?? message.msgId ?? message.id);
    const body = object(message.body) ? message.body : {};
    const text = string(body.text ?? body.content ?? message.text ?? message.content);
    if (!id || !text) throw new ProviderError('invalid_provider_response');
    const remoteRevision = identifier(message.editTime ?? message.editedAt ?? message.updatedAt ?? message.revision);
    const sourceRevision = remoteRevision && /^[A-Za-z0-9_.:-]{1,120}$/.test(remoteRevision)
      ? remoteRevision : createHash('sha256').update(text).digest('hex');
    return { externalId: id, sourceRevision, text };
  });
  const pagination = object(data.pagination) ? data.pagination : {};
  const hasMore = typeof data.hasMore === 'boolean' ? data.hasMore
    : typeof pagination.hasMore === 'boolean' ? pagination.hasMore
      : typeof pagination.totalPages === 'number' ? page < pagination.totalPages
        : messages.length >= pageSize;
  return z.object({ records: z.array(z.object({ externalId: z.string(), sourceRevision: z.string(), text: z.string() })),
    hasMore: z.boolean() }).parse({ records, hasMore });
}

export function confluencePage(result: unknown, expectedPageId: string): Page {
  const data = payload(result);
  const id = identifier(data.id ?? data.pageId);
  if (id !== expectedPageId) throw new ProviderError('invalid_provider_response');
  const body = object(data.body) ? data.body : {};
  const storage = object(body.storage) ? body.storage : {};
  const view = object(body.view) ? body.view : {};
  const text = string(storage.value ?? view.value ?? data.text ?? data.content);
  if (!text) throw new ProviderError('invalid_provider_response');
  const version = object(data.version) ? data.version.number : data.version;
  const revision = identifier(version) ?? createHash('sha256').update(text).digest('hex');
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(revision)) throw new ProviderError('invalid_provider_response');
  return { records: [{ externalId: id, sourceRevision: revision, text }], hasMore: false };
}

export async function readPage(client: ReadToolClient, scope: {
  connector: 'vanish' | 'confluence'; externalScopeId: string;
}, page: number, pageSize = 50): Promise<Page> {
  if (scope.connector === 'vanish') {
    const result = await client.call('get_session_messages', { sessionCode: scope.externalScopeId, page, pageSize });
    return vanishPage(result, page, pageSize);
  }
  if (page !== 1) throw new ProviderError('invalid_provider_response');
  const result = await client.call('confluence_get_page', { pageId: scope.externalScopeId });
  return confluencePage(result, scope.externalScopeId);
}
