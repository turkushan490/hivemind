import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { T3Model } from '../src/services/t3sync.js';
import { bearer, testApp } from './helpers.js';

// The app and its database must load after testApp sets the data folder, so the modules come in beforeAll.
let t3: typeof import('../src/services/t3sync.js');
let API_NUM_CTX = 0;
let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
const dir = mkdtempSync(join(tmpdir(), 'hm-t3-opencode-'));

beforeAll(async () => {
  process.env.T3_OPENCODE_DIR = join(dir, 'missing');
  ({ app, db } = await testApp('t3'));
  t3 = await import('../src/services/t3sync.js');
  API_NUM_CTX = (await import('../src/services/v1Models.js')).API_NUM_CTX;
  db.prepare("INSERT INTO canvases (id, owner_id, name, graph) VALUES ('c-council', 'u1', 'Council', ?)").run(JSON.stringify({ nodes: [], edges: [] }));
});
afterAll(async () => {
  delete process.env.T3_OPENCODE_DIR;
  await app.close();
});

const model = (over: Partial<T3Model> = {}): T3Model => ({
  id: 'ollama/qwen3.5:4b',
  name: 'qwen3.5:4b · Ollama',
  modelName: 'qwen3.5:4b',
  provider: 'ollama',
  providerName: 'Ollama',
  kind: 'model',
  local: true,
  tools: true,
  sizeBytes: 3.4e9,
  ...over,
});

describe('T3 names and limits', () => {
  it('names a model "name · where (role: description)"', () => {
    expect(t3.t3Name(model(), { description: 'supersnel', role: 'fast' })).toBe('qwen3.5:4b · GPU (fast: supersnel)');
    expect(t3.t3Name(model(), { name: 'Qwen 4B' })).toBe('Qwen 4B · GPU (very fast: simple code, quick checks)');
  });

  it('tells GPU, GPU+CPU, Colibri, cloud and workflows apart', () => {
    expect(t3.whereLabel(model({ sizeBytes: 24e9 }))).toBe('GPU+CPU');
    expect(t3.whereLabel(model({ provider: 'colibri', id: 'colibri/qwen36-35b' }))).toBe('Colibri CPU');
    expect(t3.whereLabel(model({ provider: 'groq', local: false }))).toBe('cloud');
    expect(t3.whereLabel(model({ kind: 'workflow', provider: 'workflow' }))).toBe('workflow');
  });

  it('describes models without a description by size, and chat-only ones as such', () => {
    expect(t3.defaultDescription(model({ sizeBytes: 7e9 }))).toMatch(/^fast/);
    expect(t3.defaultDescription(model({ sizeBytes: 18e9 }))).toMatch(/^strong/);
    expect(t3.defaultDescription(model({ sizeBytes: 24e9 }))).toMatch(/^best local/);
    expect(t3.defaultDescription(model({ tools: false }))).toBe('chat only, no file edits');
    expect(t3.defaultDescription(model({ kind: 'workflow', tools: false, description: 'Many AIs' }))).toBe('Many AIs, chat only');
  });

  it('gives Ollama models the context HiveMind really uses, others their own', () => {
    expect(t3.contextFor(model({ contextLength: 262144 }))).toBe(API_NUM_CTX);
    expect(t3.contextFor(model({ provider: 'groq', local: false, contextLength: 131072 }))).toBe(131072);
  });

  it('reads owners like 99:100 only', () => {
    expect(t3.parseOwner('99:100')).toEqual({ uid: 99, gid: 100 });
    expect(t3.parseOwner('nobody')).toBeUndefined();
  });

  it('turns /v1/models entries into rows (single models and workflows)', () => {
    const rows = t3.t3Models([
      { id: 'c1', name: 'Council', description: 'Many AIs' },
      { id: 'ollama/x', name: 'x · Ollama', owned_by: 'Ollama', hivemind: { kind: 'model', provider: 'ollama', providerKind: 'ollama', modelName: 'x', local: true, tools: true, sizeBytes: 5 } },
    ]);
    expect(rows[0]).toMatchObject({ kind: 'workflow', tools: false, description: 'Many AIs' });
    expect(rows[1]).toMatchObject({ kind: 'model', provider: 'ollama', local: true, modelName: 'x' });
  });
});

describe('opencode.json merge', () => {
  const block = () => t3.hivemindBlock([model()], { models: { 'ollama/qwen3.5:4b': { description: 'snel' }, gone: {} } }, 'http://h:4820/v1');

  it('writes only the chosen models that are still offered, with tools, thinking and limits', () => {
    const b = block();
    expect(Object.keys(b.models)).toEqual(['ollama/qwen3.5:4b']);
    expect(b.models['ollama/qwen3.5:4b']).toEqual({ name: 'qwen3.5:4b · GPU (snel)', tool_call: true, reasoning: true, limit: { context: API_NUM_CTX, output: 8192 } });
    expect(b.options).toEqual({ baseURL: 'http://h:4820/v1', apiKey: '{file:~/.config/opencode/hivemind-token}' });
  });

  it('keeps every other key and provider in the file', () => {
    const old = JSON.stringify({ $schema: 'x', agent: { plan: { model: 'a' } }, provider: { other: { name: 'Other' }, hivemind: { models: { stale: {} } } } });
    const merged = t3.mergeConfig(old, block()) as { $schema: string; agent: unknown; provider: Record<string, { models?: object }> };
    expect(merged.$schema).toBe('x');
    expect(merged.agent).toEqual({ plan: { model: 'a' } });
    expect(merged.provider.other).toEqual({ name: 'Other' });
    expect(Object.keys(merged.provider.hivemind.models ?? {})).toEqual(['ollama/qwen3.5:4b']);
  });

  it('refuses to overwrite a broken file', () => {
    expect(() => t3.mergeConfig('{ not json', block())).toThrow();
    expect(() => t3.mergeConfig('[1]', block())).toThrow(/JSON object/);
  });
});

describe('T3 routes', () => {
  it('says the folder is not mapped and refuses to update', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/t3', headers: bearer() });
    expect(r.statusCode).toBe(200);
    expect(r.json().folder.mapped).toBe(false);
    expect(r.json().models.some((m: { id: string }) => m.id === 'c-council')).toBe(true);
    const u = await app.inject({ method: 'POST', url: '/api/t3/update', headers: bearer(), payload: { models: { 'c-council': {} } } });
    expect(u.statusCode).toBe(409);
  });

  it('checks the address, owner and role it is given', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/t3', headers: bearer(), payload: { baseUrl: 'ftp://x' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/t3', headers: bearer(), payload: { owner: 'root' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/t3', headers: bearer(), payload: { models: { x: { role: 'boss' } } } })).statusCode).toBe(400);
  });

  it('writes the chosen workflow into the mapped folder, keeps the rest and makes a working token', async () => {
    process.env.T3_OPENCODE_DIR = dir;
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ provider: { other: { name: 'Other' } }, theme: 'dark' }));
    const r = await app.inject({
      method: 'POST',
      url: '/api/t3/update',
      headers: bearer(),
      payload: { baseUrl: 'http://hivemind.example.com:4820/v1', models: { 'c-council': { description: 'AIs talk it over' }, 'not-there': {} } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ written: 1, missing: ['not-there'], tokenCreated: true });
    const cfg = JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.provider.other).toEqual({ name: 'Other' });
    expect(cfg.provider.hivemind.options.baseURL).toBe('http://hivemind.example.com:4820/v1');
    expect(cfg.provider.hivemind.models['c-council']).toEqual({ name: 'Council · workflow (AIs talk it over)', tool_call: false });
    expect(existsSync(join(dir, 'opencode.json.hivemind-backup'))).toBe(true);
    const token = readFileSync(join(dir, 'hivemind-token'), 'utf8').trim();
    expect(token).toMatch(/^hm_/);
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);

    // A second update keeps the token; New token replaces it and the old one stops working.
    const again = await app.inject({ method: 'POST', url: '/api/t3/update', headers: bearer(), payload: {} });
    expect(again.json().tokenCreated).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/t3/token', headers: bearer(), payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it('downloads the same config without the token', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/t3/opencode.json', headers: bearer() });
    expect(r.statusCode).toBe(200);
    expect(r.json().provider.hivemind.options.apiKey).toBe('{file:~/.config/opencode/hivemind-token}');
    expect(JSON.stringify(r.json())).not.toMatch(/hm_[A-Za-z0-9_-]{10,}/);
  });
});
