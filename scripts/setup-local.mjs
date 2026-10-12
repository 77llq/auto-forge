import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const password = randomBytes(24).toString('hex');
const token = () => randomBytes(32).toString('hex');
const content = [
  `POSTGRES_PASSWORD=${password}`,
  `DATABASE_URL=postgresql://auto_forge:${password}@127.0.0.1:55438/auto_forge`,
  `TEST_DATABASE_URL=postgresql://auto_forge:${password}@127.0.0.1:55438/auto_forge_test`,
  `CONTROL_API_TOKEN=${token()}`,
  `WORKER_API_TOKEN=${token()}`,
  'PORT=4318',
  'WORKER_ID=local-simulation-worker',
  '',
].join('\n');
try {
  await writeFile(new URL('../.env', import.meta.url), content, { flag: 'wx', mode: 0o600 });
  console.log('Created private .env. Tokens are not printed. Next: npm run db:up && npm run db:migrate');
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
    console.log('.env already exists; kept it unchanged.');
  } else throw error;
}
