import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`${status}: ${code}`); }
}

export class ForgeClient {
  constructor(readonly baseUrl: string, private readonly token: string) {}
  async request<T>(path: string, value?: unknown, commandKey = randomUUID()): Promise<T> {
    // A retry must reuse the same idempotency key, including claim requests.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          method: value === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': commandKey },
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
          signal: AbortSignal.timeout(20_000),
        });
        const data = await response.json() as T & { error?: string };
        if (!response.ok) throw new ApiError(response.status, data.error ?? 'request_failed');
        return data;
      } catch (error) {
        if (error instanceof ApiError || attempt >= 2) throw error;
        await delay(200 * (attempt + 1));
      }
    }
  }
}
