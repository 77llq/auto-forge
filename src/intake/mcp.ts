import { readFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { ProviderError, type ReadToolClient } from './provider.js';

const stdio = z.strictObject({ transport: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).default([]) });
const http = z.strictObject({ transport: z.literal('http'), url: z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'http:' && ['127.0.0.1','localhost','::1'].includes(url.hostname);
}) });
const configSchema = z.strictObject({ vanish: z.discriminatedUnion('transport', [stdio,http]).optional(),
  confluence: z.discriminatedUnion('transport', [stdio,http]).optional() });
export type McpConfig = z.infer<typeof configSchema>;

export async function readMcpConfig(path: string): Promise<McpConfig> {
  return configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export async function connectReadTools(spec: NonNullable<McpConfig['vanish']>, connector: 'vanish' | 'confluence'):
  Promise<ReadToolClient & { close(): Promise<void> }> {
  const client = new Client({ name: 'auto-forge-intake', version: '0.2.0' });
  const transport = spec.transport === 'stdio'
    ? new StdioClientTransport({ command: spec.command, args: spec.args })
    : new StreamableHTTPClientTransport(new URL(spec.url));
  try {
    await client.connect(transport);
    const required = connector === 'vanish' ? 'get_session_messages' : 'confluence_get_page';
    const tools = await client.listTools();
    if (!tools.tools.some(tool => tool.name === required)) throw new ProviderError('invalid_provider_response');
    return {
      async call(name, args) {
        if (name !== required) throw new ProviderError('invalid_provider_response');
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) throw new ProviderError('provider_error');
        return result;
      },
      async close() { await client.close(); },
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
