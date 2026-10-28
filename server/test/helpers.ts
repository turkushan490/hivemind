import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasGraph, CanvasNode, RunEvent } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import type { ResolvedProvider } from '../src/engine/run.js';
import type { ChatRequest } from '../src/providers/types.js';

/** A full app on a fresh data folder, with users (admin "u1", plus extras) that each have the token hm_<id>. */
export async function testApp(prefix: string, users: [string, 'admin' | 'user' | 'viewer'][] = [['u1', 'admin']]) {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), `hm-${prefix}-`));
  const { buildApp } = await import('../src/app.js');
  const { db } = await import('../src/db/index.js');
  const { sha256 } = await import('../src/crypto.js');
  for (const [id, role] of users) {
    db.prepare('INSERT INTO users (id, username, pw_hash, role) VALUES (?, ?, ?, ?)').run(id, `user_${id}`, 'x', role);
    db.prepare("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES (?, ?, 't', ?, 'hm_')").run(`t-${id}`, id, sha256(`hm_${id}`));
  }
  const app = await buildApp({ logger: false, web: false });
  await app.ready();
  return { app, db };
}

export const bearer = (id = 'u1') => ({ authorization: `Bearer hm_${id}` });

/** Starts a run over the API and waits until it is stored; returns GET /api/runs/:id. */
export async function runAndWait(app: FastifyInstance, payload: Record<string, unknown>, who = 'u1') {
  const start = await app.inject({ method: 'POST', url: '/api/runs', headers: bearer(who), payload });
  if (start.statusCode !== 200) throw new Error(`POST /api/runs ${start.statusCode}: ${start.body}`);
  const { runId } = start.json() as { runId: string };
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: bearer(who) });
    if (res.statusCode === 200) return res.json() as { id: string; status: string; final?: string; events: RunEvent[]; outputs?: Record<string, { nodeId: string; type: string; text: string }> };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Run did not finish');
}

export const node = (id: string, type: CanvasNode['type'], config: CanvasNode['config'] = {}, label?: string): CanvasNode => ({ id, type, label, position: { x: 0, y: 0 }, config });
export const edge = (a: string, b: string) => ({ id: `${a}->${b}`, source: a, target: b });
/** A straight line of blocks: input → … → output. */
export const chain = (...nodes: CanvasNode[]): CanvasGraph => ({ nodes, edges: nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id)) });

/** Fake model provider: answers with reply(req) (default "<model>: ok"), records every request. */
export function fakeProvider(reply: (req: ChatRequest, n: number) => string = (r) => `${r.model}: ok`, opts: { local?: boolean } = {}) {
  const calls: ChatRequest[] = [];
  const p: ResolvedProvider & { calls: ChatRequest[] } = {
    calls,
    local: !!opts.local,
    hostKey: 'host',
    modelInfo: async () => undefined,
    adapter: {
      listModels: async () => [],
      async *stream(req: ChatRequest) {
        calls.push(req);
        yield { type: 'token' as const, text: reply(req, calls.length) };
        yield { type: 'done' as const, inputTokens: 10, outputTokens: 2 };
      },
    },
  };
  return p;
}
