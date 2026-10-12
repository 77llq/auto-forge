import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

serveStdio(() => {
  const server = new McpServer({ name: 'auto-forge-synthetic-read-server', version: '1.0.0' },
    { capabilities: { tools: {} } });
  server.registerTool('get_session_messages', {
    inputSchema: z.object({ sessionCode: z.string(), page: z.number(), pageSize: z.number() }),
  }, async ({ sessionCode, page }) => ({
    content: [{ type: 'text', text: JSON.stringify({ messages: [{ id: `${sessionCode}-${page}`,
      text: 'Synthetic fixture request' }], hasMore: false }) }],
  }));
  server.registerTool('confluence_get_page', {
    inputSchema: z.object({ pageId: z.string() }),
  }, async ({ pageId }) => ({
    content: [{ type: 'text', text: JSON.stringify({ id: pageId, text: 'Synthetic fixture PRD', version: 1 }) }],
  }));
  server.registerTool('write_message', {
    inputSchema: z.object({ text: z.string() }),
  }, async () => ({ content: [{ type: 'text', text: 'This tool must never be called' }] }));
  return server;
});
