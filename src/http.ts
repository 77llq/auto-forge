import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import { contractCatalog, key } from './contracts.js';
import { DomainError } from './domain.js';
import type { ForgeService } from './service.js';
import { IntakeService } from './intake/service.js';
import { intakeContractCatalog } from './intake/contracts.js';

export type HttpOptions = { controlToken: string; workerToken: string; intakeToken?: string; workerId: string };
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/intake.css', ['intake.css', 'text/css; charset=utf-8']],
]);

function authorize(request: IncomingMessage, token: string): void {
  const received = request.headers.authorization ?? '';
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(received), digest(`Bearer ${token}`))) throw new DomainError('unauthorized', 401);
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new DomainError('json_required', 415);
  if (Number(request.headers['content-length'] ?? 0) > 65_536) throw new DomainError('body_too_large', 413);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) { reject(new DomainError('body_too_large', 413)); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > 65_536) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new DomainError('invalid_json', 400)); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new DomainError('request_aborted', 400)));
  });
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export function createHttpServer(service: ForgeService, options: HttpOptions) {
  if (options.controlToken.length < 32 || options.workerToken.length < 32 || options.controlToken === options.workerToken) {
    throw new Error('Distinct control and worker tokens of at least 32 characters are required');
  }
  if (options.intakeToken && (options.intakeToken.length < 32 || [options.controlToken, options.workerToken].includes(options.intakeToken))) {
    throw new Error('A distinct intake token of at least 32 characters is required');
  }
  key.parse(options.workerId);
  const intake = new IntakeService(service.pool);
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && assets.has(pathname)) {
        const [filename, contentType] = assets.get(pathname)!;
        const content = await readFile(new URL(`../public/${filename}`, import.meta.url))
          .catch(async () => readFile(new URL(`../../public/${filename}`, import.meta.url)));
        response.writeHead(200, { 'Content-Type': contentType! });
        response.end(content);
        return;
      }
      if (request.method === 'GET' && pathname === '/health') {
        try { await service.pool.query('SELECT 1'); send(response, 200, { status: 'ok', mode: 'simulation' }); }
        catch { send(response, 503, { status: 'unavailable' }); }
        return;
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new DomainError('cross_site_forbidden', 403);
      if (pathname.startsWith('/internal/v1/intake/') && !options.intakeToken) throw new DomainError('intake_not_configured', 503);
      authorize(request, pathname.startsWith('/internal/v1/intake/') ? options.intakeToken!
        : pathname.startsWith('/internal/') ? options.workerToken : options.controlToken);
      let value: unknown;
      let commandKey = '';
      if (request.method === 'POST') {
        if (!pathname.endsWith('/heartbeat')) {
          const parsed = key.safeParse(request.headers['idempotency-key']);
          if (!parsed.success) throw new DomainError('idempotency_key_required', 400);
          commandKey = parsed.data;
        }
        value = await body(request);
      }
      let match: RegExpExecArray | null;
      let result: unknown;
      if (request.method === 'GET' && pathname === '/v1/contracts') result = { ...contractCatalog(), ...intakeContractCatalog() };
      else if (request.method === 'GET' && pathname === '/v1/projects') result = { projects: await service.listProjects() };
      else if (request.method === 'GET' && pathname === '/internal/v1/intake/scopes') result = { scopes: await intake.listScopes() };
      else if (request.method === 'GET' && (match = /^\/v1\/projects\/([^/]+)\/intake$/.exec(pathname))) {
        result = await intake.projectSnapshot(match[1]!);
      }
      else if (request.method === 'GET' && (match = /^\/v1\/projects\/([^/]+)\/snapshot$/.exec(pathname))) {
        result = await service.projectSnapshot(match[1]!);
      } else if (request.method === 'GET' && (match = /^\/v1\/deliveries\/([^/]+)$/.exec(pathname))) {
        result = await service.deliverySnapshot(match[1]!);
      } else if (request.method === 'POST' && pathname === '/v1/projects') result = await service.createProject(commandKey, value);
      else if (request.method === 'POST' && (match = /^\/v1\/projects\/([^/]+)\/scopes$/.exec(pathname))) {
        result = await intake.registerScope(commandKey, match[1]!, value);
      } else if (request.method === 'POST' && (match = /^\/v1\/scopes\/([^/]+)\/state$/.exec(pathname))) {
        result = await intake.setScopeState(commandKey, match[1]!, value);
      } else if (request.method === 'POST' && (match = /^\/v1\/projects\/([^/]+)\/drafts$/.exec(pathname))) {
        result = await intake.createDraft(commandKey, match[1]!, value);
      } else if (request.method === 'POST' && (match = /^\/v1\/drafts\/([^/]+)\/(revise|approve)$/.exec(pathname))) {
        result = match[2] === 'revise' ? await intake.reviseDraft(commandKey, match[1]!, value)
          : await intake.approveDraft(commandKey, match[1]!, value);
      } else if (request.method === 'POST' && (match = /^\/internal\/v1\/intake\/scopes\/([^/]+)\/runs$/.exec(pathname))) {
        result = await intake.startRun(commandKey, match[1]!, value);
      } else if (request.method === 'POST' && (match = /^\/internal\/v1\/intake\/runs\/([^/]+)\/(pages|fail)$/.exec(pathname))) {
        result = match[2] === 'pages' ? await intake.ingestPage(commandKey, match[1]!, value)
          : await intake.failRun(commandKey, match[1]!, value);
      }
      else if (request.method === 'POST' && (match = /^\/v1\/projects\/([^/]+)\/(sources|requirements|deliveries)$/.exec(pathname))) {
        const projectId = match[1]!;
        result = match[2] === 'sources' ? await service.createSource(commandKey, projectId, value)
          : match[2] === 'requirements' ? await service.createRequirement(commandKey, projectId, value)
          : await service.createDelivery(commandKey, projectId, value);
      } else if (request.method === 'POST' && (match = /^\/v1\/requirements\/([^/]+)\/ready$/.exec(pathname))) {
        result = await service.readyRequirement(commandKey, match[1]!, value);
      } else if (request.method === 'POST' && (match = /^\/v1\/deliveries\/([^/]+)\/control$/.exec(pathname))) {
        result = await service.control(commandKey, match[1]!, value);
      } else if (request.method === 'POST' && pathname === '/internal/v1/jobs/claim') {
        result = await service.claim(commandKey, options.workerId, value);
      } else if (request.method === 'POST' && (match = /^\/internal\/v1\/jobs\/([^/]+)\/(heartbeat|complete)$/.exec(pathname))) {
        result = match[2] === 'heartbeat' ? await service.heartbeat(options.workerId, match[1]!, value)
          : await service.complete(commandKey, options.workerId, match[1]!, value);
      } else throw new DomainError('route_not_found', 404);
      send(response, 200, result);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof ZodError) send(response, 400, { error: 'invalid_request', fields: error.issues.map(item => item.path.join('.')), requestId });
      else if (error instanceof DomainError) send(response, error.status, { error: error.code, requestId });
      else {
        // Never log SQL parameters, request bodies, environment variables, or bearer tokens.
        console.error(JSON.stringify({ level: 'error', event: 'request_failed', requestId }));
        send(response, 500, { error: 'internal_error', requestId });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.timeout = 20_000;
  server.maxHeadersCount = 50;
  return server;
}
