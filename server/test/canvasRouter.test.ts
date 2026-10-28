import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, chain, node, testApp } from './helpers.js';

let app: FastifyInstance;
let sent: any[] = [];

beforeAll(async () => {
  let db;
  ({ app, db } = await testApp('router'));
  const { encrypt } = await import('../src/crypto.js');
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, api_key_enc, local) VALUES ('ts', 'typesafe', 'decision', 'Jev', 'https://api.typesafe.ai', ?, 0)").run(encrypt('k'));
  for (const [id, name, text] of [
    ['lights', 'Lights', 'Lights: {{question}}'],
    ['recipes', 'Recipes', 'Recipes: {{question}}'],
  ])
    await app.inject({ method: 'PUT', url: `/api/canvases/${id}`, headers: bearer(), payload: { name, description: `About ${name.toLowerCase()}`, ...chain(node('q', 'input'), node('t', 'template', { prompt: text }), node('o', 'output')) } });
});
afterAll(() => app?.close());
afterEach(() => vi.unstubAllGlobals());

const mockJev = (choice: string) => {
  sent = [];
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init!.body)));
    return Response.json({ model: 'jev-1.14.0', answers: { canvas: { type: 'choice', choice, probabilities: { [choice]: 0.9 } } }, usage: { input_tokens: 100 } });
  });
};

describe('canvas router (voice / HA)', () => {
  it('is off until a decision model is set', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/route-canvas', headers: bearer(), payload: { text: 'turn on the lights' } });
    expect(res.statusCode).toBe(400);
  });

  it('asks Jev which canvas, with names and descriptions as options', async () => {
    await app.inject({ method: 'PUT', url: '/api/me/prefs', headers: bearer(), payload: { canvasRouter: { providerId: 'ts', model: 'jev-latest' } } });
    mockJev('lights');
    const res = await app.inject({ method: 'POST', url: '/api/route-canvas', headers: bearer(), payload: { text: 'turn on the lights' } });
    expect(res.json()).toMatchObject({ canvasId: 'lights', name: 'Lights' });
    expect(sent[0].questions.canvas.criteria).toEqual({ recipes: 'Recipes: About recipes', lights: 'Lights: About lights' });
  });

  it('/v1 model "auto" runs the picked canvas', async () => {
    mockJev('recipes');
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: bearer(), payload: { model: 'auto', messages: [{ role: 'user', content: 'pancakes?' }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('Recipes: pancakes?');
    const models = (await app.inject({ method: 'GET', url: '/v1/models', headers: bearer() })).json();
    expect(models.data[0].id).toBe('auto');
  });
});
