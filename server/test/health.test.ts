import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'hm-health-'));
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({ logger: false, web: false });
  await app.ready();
});
afterAll(() => app?.close());

describe('/api/health', () => {
  it('answers without login, with the version and the feature list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(Array.isArray(body.features)).toBe(true);
    expect(new Set(body.features).size).toBe(body.features.length);
  });
});
