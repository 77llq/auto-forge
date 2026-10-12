import { z } from 'zod';
import { key } from './contracts.js';

const environment = z.object({
  DATABASE_URL: z.url().refine(value => /^postgres(?:ql)?:\/\//.test(value)),
  CONTROL_API_TOKEN: z.string().min(32),
  WORKER_API_TOKEN: z.string().min(32),
  WORKER_ID: key.default('local-simulation-worker'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(4318),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = environment.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(item => item.path.join('.')).join(', ')}`);
  if (result.data.CONTROL_API_TOKEN === result.data.WORKER_API_TOKEN) throw new Error('Control and worker tokens must be different');
  if ([result.data.CONTROL_API_TOKEN, result.data.WORKER_API_TOKEN].some(token => token.includes('replace-'))) {
    throw new Error('Replace example tokens with generated secrets');
  }
  return result.data;
}
