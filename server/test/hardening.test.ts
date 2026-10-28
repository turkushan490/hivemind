import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockedReason } from '../src/services/net.js';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  ({ app } = await testApp('harden', [
    ['u1', 'admin'],
    ['u2', 'user'],
  ]));
});
afterAll(() => app?.close());

describe('providers', () => {
  it('lets users add cloud providers with their own key, but only admins point one at an address', async () => {
    const add = (who: string, payload: object) => app.inject({ method: 'POST', url: '/api/providers', headers: bearer(who), payload });
    expect((await add('u2', { preset: 'groq', apiKey: 'k' })).statusCode).toBe(200);
    expect((await add('u2', { preset: 'groq', apiKey: 'k', baseUrl: 'http://192.168.1.1/' })).statusCode).toBe(403);
    expect((await add('u2', { preset: 'custom', baseUrl: 'http://10.0.0.5:8080/v1' })).statusCode).toBe(403);
    expect((await add('u2', { preset: 'ollama' })).statusCode).toBe(403);
    expect((await add('u1', { preset: 'custom', baseUrl: 'http://10.0.0.5:8080/v1' })).statusCode).toBe(200);
  });

  it('refuses address changes by users', async () => {
    const mine = (await app.inject({ method: 'POST', url: '/api/providers', headers: bearer('u2'), payload: { preset: 'gemini', apiKey: 'k' } })).json() as { id: string };
    const patch = (payload: object) => app.inject({ method: 'PATCH', url: `/api/providers/${mine.id}`, headers: bearer('u2'), payload });
    expect((await patch({ baseUrl: 'http://169.254.169.254/' })).statusCode).toBe(403);
    expect((await patch({ name: 'My Gemini' })).statusCode).toBe(200);
  });
});

describe('problem reports', () => {
  it('are limited per sender and cut to size', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await app.inject({ method: 'POST', url: '/api/problems/report', headers: bearer('u2'), payload: { message: 'x'.repeat(5000) } })).statusCode;
    expect(last).toBe(429);
    // Another sender is not affected.
    expect((await app.inject({ method: 'POST', url: '/api/problems/report', headers: bearer('u1'), payload: { message: 'real' } })).statusCode).toBe(200);
  });
});

describe('setup', () => {
  it('is refused once an account exists', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'eve', password: 'password123' } })).statusCode).toBe(409);
  });
});

describe('address guard and names', () => {
  it('knows what may not be called', () => {
    expect(blockedReason('169.254.169.254')).toMatch(/metadata/);
    expect(blockedReason('::ffff:127.0.0.1')).toMatch(/loopback/);
    expect(blockedReason('192.168.1.5')).toBeUndefined();
    expect(blockedReason('192.168.1.5', false)).toMatch(/private/);
    expect(blockedReason('fd00::1', false)).toMatch(/private/);
    expect(blockedReason('8.8.8.8', false)).toBeUndefined();
  });

  it('never turns a name into "." or ".."', async () => {
    // Loaded after testApp chose its data folder.
    const { cleanName } = await import('../src/services/files.js');
    expect(cleanName('..')).toBe('file');
    expect(cleanName('.')).toBe('file');
    expect(cleanName('../x')).toBe('..-x');
  });
});
