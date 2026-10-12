import { createHash } from 'node:crypto';

export class DomainError extends Error {
  constructor(public readonly code: string, public readonly status = 409, message = code) {
    super(message);
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new DomainError('invalid_json', 400);
}

export const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const finalPhases = new Set(['simulation_completed', 'failed', 'cancelled']);
