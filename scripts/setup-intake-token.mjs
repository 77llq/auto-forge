import { randomBytes } from 'node:crypto';
import { readFile, appendFile, chmod } from 'node:fs/promises';
const path = new URL('../.env', import.meta.url);
const content = await readFile(path, 'utf8');
if (/^INTAKE_API_TOKEN=/m.test(content)) {
  console.log('Intake token already exists; kept it unchanged.');
} else {
  await appendFile(path, `\nINTAKE_API_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  console.log('Added a private intake token. Its value was not printed.');
}
