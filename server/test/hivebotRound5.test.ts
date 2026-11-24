import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanvasGraph, RunEvent } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedProvider } from '../src/engine/run.js';
import { node, runAndWait, testApp } from './helpers.js';

let app: FastifyInstance;
let mem: typeof import('../src/services/memoryFiles.js');
let nodes: typeof import('../src/nodes/index.js');

beforeAll(async () => {
  ({ app } = await testApp('round5'));
  mem = await import('../src/services/memoryFiles.js');
  nodes = await import('../src/nodes/index.js');
});
afterAll(() => app.close());

/** A minimal NodeContext for one block. */
function ctx(type: string, config: Record<string, unknown>, input = '', outgoing: { id: string; label: string }[] = [], vars: Record<string, string> = {}) {
  const chosen: string[] = [];
  const said: string[] = [];
  const c = {
    node: { id: 'n', type, position: { x: 0, y: 0 }, config },
    question: 'q',
    vars,
    inputs: input ? [{ nodeId: 'a', type: 'llm', label: 'Front desk', text: input }] : [],
    outgoing: outgoing.map((o) => ({ ...o, type: 'llm' })),
    callModel: async () => {
      throw new Error('no model here');
    },
    choose: (ids: string[]) => chosen.push(...ids),
    progress: () => {},
    say: (t: string) => said.push(t),
    decide: async () => {
      throw new Error('no');
    },
    generateImage: async () => [],
    attach: () => {},
    services: {
      memoryFiles: {
        tree: () => mem.tree('u1').map((f) => ({ path: f.path, title: f.title })),
        read: (p: string[]) => mem.read('u1', p),
        write: (p: string, t: string, o?: { mode?: 'replace' | 'append'; by?: string }) => void mem.write('u1', p, t, o),
        move: (a: string, b: string, by?: string) => mem.move('u1', a, b, by),
        remove: (p: string) => mem.remove('u1', p),
      },
    },
  };
  return { c: c as never, chosen, said };
}

describe('H17 memory versions', () => {
  it('a writer with a slash in its name never blocks the next write, and a version is kept', () => {
    mem.write('u1', 'stories/current.md', 'one', { by: 'ghost (from topics/games/a.md)' });
    mem.write('u1', 'stories/current.md', 'two', { by: 'jarvis' });
    mem.write('u1', 'stories/current.md', 'three', { mode: 'append', by: 'x/y\\z' });
    expect(mem.read('u1', ['stories/current.md'])[0].content).toBe('two\nthree');
    const v = mem.versions('u1', 'stories/current.md');
    expect(v.length).toBe(2);
    expect(v.every((x) => !x.id.includes('/'))).toBe(true);
  });
});

describe('H14 memory and routing', () => {
  it('readMemory with the index leaves archive/ out; search too', async () => {
    mem.write('u1', 'topics/potatoes.md', '# Potatoes\nboil 20 min');
    mem.write('u1', 'old.md', '# Old\npotatoes wrong');
    mem.remove('u1', 'old.md');
    const tree = mem.tree('u1').map((f) => f.path);
    expect(tree.some((p) => p.startsWith('archive/deleted/'))).toBe(true);
    const { c } = ctx('readMemory', { memoryIndex: true });
    const out = await nodes.NODES.readMemory.execute(c);
    expect(out).toContain('topics/potatoes.md');
    expect(out).not.toContain('archive/');
    expect(mem.search('u1', 'potatoes').map((h) => h.path)).toEqual(['topics/potatoes.md']);
  });

  it('readMemory with memoryList gives only the paths in that folder: no guest/, no empty files', async () => {
    mem.write('u1', 'conversations/cats.md', '- Owner: I like cats');
    mem.write('u1', 'conversations/empty.md', '');
    mem.write('u1', 'guest/conversations/dogs.md', '- Guest: dogs');
    const { c } = ctx('readMemory', { memoryList: 'conversations' });
    const out = await nodes.NODES.readMemory.execute(c);
    expect(out.split('\n')).toContain('conversations/cats.md');
    expect(out).not.toContain('guest/');
    expect(out).not.toContain('empty.md');
    const none = ctx('readMemory', { memoryList: 'nothing-here/' });
    expect(await nodes.NODES.readMemory.execute(none.c)).toBe('none');
  });

  it('a file in archive/deleted is deleted for real', () => {
    const p = mem.tree('u1').find((f) => f.path.startsWith('archive/deleted/'))!.path;
    mem.remove('u1', p);
    expect(mem.tree('u1').some((f) => f.path === p)).toBe(false);
  });

  it('writeMemory moves and deletes with the path from the input', async () => {
    mem.write('u1', 'conv/1.md', 'talk');
    await nodes.NODES.writeMemory.execute(ctx('writeMemory', {}, '{"from":"conv/1.md","to":"archive/conv/1.md"}').c);
    expect(mem.read('u1', ['archive/conv/1.md'])[0].content).toBe('talk');
    await nodes.NODES.writeMemory.execute(ctx('writeMemory', {}, '```json\n{"path":"archive/conv/1.md","delete":true}\n```').c);
    expect(mem.read('u1', ['archive/conv/1.md'])[0].content).toBeUndefined();
    await nodes.NODES.writeMemory.execute(ctx('writeMemory', { memoryPath: 'notes/{{inputs}}' }, 'a.md').c);
    expect(mem.read('u1', ['notes/a.md'])[0].content).toBe('a.md');
  });

  it('the Router routes by a value without a model, with an else branch', async () => {
    const out = [
      { id: 'j', label: 'Jarvis' },
      { id: 'u', label: 'ultron' },
      { id: 'e', label: 'else' },
    ];
    const a = ctx('router', { routeBy: '{{vars.character}}' }, 'hi', out, { character: 'JARVIS' });
    await nodes.NODES.router.execute(a.c);
    expect(a.chosen).toEqual(['j']);
    const b = ctx('router', { routeBy: '{{vars.character}}' }, 'hi', out, { character: 'ghost' });
    await nodes.NODES.router.execute(b.c);
    expect(b.chosen).toEqual(['e']);
    expect(nodes.NODES.router.modelOptional!({ routeBy: '{{vars.x}}' })).toBe(true);
  });

  it('sayNow skips empty or "-" text and drops ### headers', async () => {
    const a = ctx('sayNow', {}, '-');
    await nodes.NODES.sayNow.execute(a.c);
    expect(a.said).toEqual([]);
    const b = ctx('sayNow', {}, '### Front desk\nOne moment.');
    await nodes.NODES.sayNow.execute(b.c);
    expect(b.said).toEqual(['One moment.']);
  });

  it('the Condition block picks yes or no without a model', async () => {
    const out = [
      { id: 'y', label: 'yes' },
      { id: 'n2', label: 'no' },
    ];
    const a = ctx('condition', { conditionText: 'error' }, 'Build ERROR at line 4', out);
    expect(await nodes.NODES.condition.execute(a.c)).toBe('Build ERROR at line 4');
    expect(a.chosen).toEqual(['y']);
    const b = ctx('condition', { conditionText: '/line \\d+/', conditionNot: true }, 'line 4', out);
    await nodes.NODES.condition.execute(b.c);
    expect(b.chosen).toEqual(['n2']);
  });

  it('a raw Template passes the inputs without the ### header', async () => {
    expect(await nodes.NODES.template.execute(ctx('template', { raw: true }, 'topics/a.md').c)).toBe('topics/a.md');
    expect(await nodes.NODES.template.execute(ctx('template', {}, 'x').c)).toContain('### Front desk');
  });

  it('night work counts one night from evening to noon', async () => {
    const { nightOf } = await import('../src/services/nightWork.js');
    expect(nightOf(new Date(2026, 10, 13, 1, 30))).toBe(nightOf(new Date(2026, 10, 13, 2, 40)));
    expect(nightOf(new Date(2026, 10, 12, 23, 0))).toBe(nightOf(new Date(2026, 10, 13, 2, 40)));
    expect(nightOf(new Date(2026, 10, 13, 23, 0))).not.toBe(nightOf(new Date(2026, 10, 13, 2, 40)));
  });
});

describe('H22 night window', () => {
  it('knows the window, also across midnight', async () => {
    const { inNightWindow } = await import('../src/services/nightWork.js');
    const s = { enabled: true, fromHour: 23, toHour: 6 };
    expect(inNightWindow(new Date(2026, 10, 17, 23, 30), s)).toBe(true);
    expect(inNightWindow(new Date(2026, 10, 18, 5, 59), s)).toBe(true);
    expect(inNightWindow(new Date(2026, 10, 18, 6, 0), s)).toBe(false);
    expect(inNightWindow(new Date(2026, 10, 18, 12, 0), { enabled: true, fromHour: 0, toHour: 6 })).toBe(false);
  });
});

describe('H16 the tail after the Output', () => {
  it('waits until the answer is out and the voice is quiet', async () => {
    const { runGraph } = await import('../src/engine/run.js');
    const p: ResolvedProvider = {
      local: false,
      hostKey: 'x',
      modelInfo: async () => ({ providerId: 'p', model: 'm', name: 'm', free: true }),
      adapter: {
        listModels: async () => [],
        async *stream(req: { model: string }) {
          yield { type: 'token' as const, text: req.model };
          yield { type: 'done' as const };
        },
      },
    } as never;
    const g: CanvasGraph = {
      nodes: [node('q', 'input'), node('a', 'llm', { model: { providerId: 'p', model: 'answer' } }), node('o', 'output'), node('w', 'llm', { model: { providerId: 'p', model: 'writer' } })],
      edges: [
        { id: '1', source: 'q', target: 'a' },
        { id: '2', source: 'a', target: 'o' },
        { id: '3', source: 'a', target: 'w' },
      ],
    };
    const events: RunEvent[] = [];
    const order: string[] = [];
    let gateAt = 0;
    await runGraph(
      g,
      'hi',
      {
        resolve: async () => p,
        emit: (e) => {
          events.push(e as RunEvent);
          if ((e as RunEvent).type === 'answer') order.push('answer');
          if ((e as RunEvent).type === 'node_start' && (e as RunEvent).nodeId === 'w') order.push('tail');
        },
        afterAnswer: async (at) => {
          gateAt = at;
          order.push('gate');
          await new Promise((r) => setTimeout(r, 50));
        },
      },
      new AbortController().signal,
    );
    expect(gateAt).toBeGreaterThan(0);
    expect(order).toEqual(['answer', 'gate', 'tail']);
  });

  it('voiceQuiet goes on when nothing is spoken, and waits for speech that is going on', async () => {
    const { speaking, voiceQuiet } = await import('../src/services/speaking.js');
    let t = Date.now();
    await voiceQuiet('nobody', { since: t, firstMs: 100 });
    expect(Date.now() - t).toBeLessThan(1000);
    t = Date.now();
    const talk = speaking('u9', () => new Promise((r) => setTimeout(r, 400)));
    await voiceQuiet('u9', { since: t, quietMs: 100 });
    await talk;
    expect(Date.now() - t).toBeGreaterThanOrEqual(450);
  });
});

describe('H17 on disk', () => {
  it('keeps no folder named after a writer', () => {
    const dir = join(process.env.DATA_DIR!, 'memory');
    if (!existsSync(dir)) return;
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name, ...walk(join(d, e.name))] : []));
    expect(walk(dir).some((n) => n.includes('(from '))).toBe(false);
  });
});

// Keeps runAndWait referenced for future API-level checks of these blocks.
void runAndWait;
