import test from 'node:test';
import assert from 'node:assert/strict';
import { confluencePage, ProviderError, readPage, vanishPage } from '../src/intake/provider.js';
import { connectReadTools } from '../src/intake/mcp.js';
import { fileURLToPath } from 'node:url';

test('Vanish page normalizes stable IDs, text, revisions and pagination', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const provider = { async call(name: 'get_session_messages' | 'confluence_get_page', args: Record<string, unknown>) {
    calls.push({ name, args });
    return { structuredContent: { messages: [
      { messageId: 'm-1', body: { text: 'Need audit trail' }, editedAt: '2026-10-12T12:00:00Z' },
      { id: 2, text: 'Need pause control' },
    ], pagination: { hasMore: false } } };
  } };
  const page = await readPage(provider, { connector: 'vanish', externalScopeId: 'approved-session' }, 2, 50);
  assert.deepEqual(calls, [{ name: 'get_session_messages', args: { sessionCode: 'approved-session', page: 2, pageSize: 50 } }]);
  assert.equal(page.hasMore, false);
  assert.equal(page.records[0]!.sourceRevision, '2026-10-12T12:00:00Z');
  assert.equal(page.records[1]!.externalId, '2');
  assert.match(page.records[1]!.sourceRevision, /^[a-f0-9]{64}$/);
});

test('Confluence page uses page/version identity and does not follow links or call writes', async () => {
  const calls: string[] = [];
  const provider = { async call(name: 'get_session_messages' | 'confluence_get_page') {
    calls.push(name);
    return { content: [{ type: 'text', text: JSON.stringify({ id: '12345', body: { storage: { value: '<p>PRD v3</p>' } }, version: { number: 3 } }) }] };
  } };
  const page = await readPage(provider, { connector: 'confluence', externalScopeId: '12345' }, 1);
  assert.deepEqual(calls, ['confluence_get_page']);
  assert.deepEqual(page, { records: [{ externalId: '12345', sourceRevision: '3', text: '<p>PRD v3</p>' }], hasMore: false });
  assert.throws(() => confluencePage({ structuredContent: { id: 'other', text: 'secret' } }, '12345'),
    error => error instanceof ProviderError && error.code === 'invalid_provider_response');
});

test('permission denial and malformed provider responses fail closed', () => {
  assert.throws(() => vanishPage({ structuredContent: { accessDenied: true, messages: [] } }, 1, 50),
    error => error instanceof ProviderError && error.code === 'access_denied');
  assert.throws(() => vanishPage({ structuredContent: { messages: [{ id: 'm-1', body: { type: 'image' } }] } }, 1, 50),
    error => error instanceof ProviderError && error.code === 'invalid_provider_response');
  assert.throws(() => confluencePage({ isError: true, content: [] }, '12345'),
    error => error instanceof ProviderError && error.code === 'provider_error');
});

test('MCP stdio handshake reads only the exact allowlisted tool', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/read-server.ts', import.meta.url));
  const client = await connectReadTools({ transport: 'stdio', command: process.execPath,
    args: ['--import', 'tsx', fixture] }, 'vanish');
  try {
    const page = await readPage(client, { connector: 'vanish', externalScopeId: 'synthetic-session' }, 1);
    assert.equal(page.records[0]?.externalId, 'synthetic-session-1');
    await assert.rejects(client.call('confluence_get_page', { pageId: '1' }),
      error => error instanceof ProviderError && error.code === 'invalid_provider_response');
  } finally { await client.close(); }
});
