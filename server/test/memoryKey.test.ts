import type { RunEvent } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { runGraph } from '../src/engine/run.js';
import { memoryKey, type NodeServices } from '../src/nodes/index.js';
import { chain, edge, node } from './helpers.js';

/** A memory service in a Map, like the real one per user. */
function memStore() {
  const keys = new Map<string, string[]>();
  const memory: NonNullable<NodeServices['memory']> = {
    recall: (key, limit) => (keys.get(key) ?? []).slice(-limit).map((text) => ({ text, at: 'now' })),
    save: (key, text) => void keys.set(key, [...(keys.get(key) ?? []), text]),
  };
  return { keys, memory };
}

const go = async (graph: Parameters<typeof runGraph>[0], question: string, vars: Record<string, string>, services: NodeServices) => {
  const events: RunEvent[] = [];
  const result = await runGraph(graph, question, { resolve: async () => Promise.reject(new Error('no models')), emit: (e) => events.push(e as RunEvent), services }, new AbortController().signal, vars);
  return { result, events };
};

describe('templated memory key', () => {
  it('fills, trims and limits the key; empty becomes default', () => {
    const ctx = { question: 'q', vars: { tableId: 't_8f2k', long: 'x'.repeat(200) } };
    expect(memoryKey('dnd:{{vars.tableId}}', ctx)).toBe('dnd:t_8f2k');
    expect(memoryKey('  {{vars.missing}}  ', ctx)).toBe('default');
    expect(memoryKey(undefined, ctx)).toBe('default');
    expect(memoryKey('k:{{vars.long}}', ctx)).toHaveLength(120);
  });

  it('keeps one memory per table: two runs save under two keys and recall stays separate', async () => {
    const { keys, memory } = memStore();
    const save = chain(node('q', 'input'), node('s', 'memory', { key: 'dnd:{{vars.tableId}}', mode: 'save' }));
    await go(save, 'The hag flees', { tableId: 'a' }, { memory });
    await go(save, 'The dragon wakes', { tableId: 'b' }, { memory });
    expect([...keys.keys()].sort()).toEqual(['dnd:a', 'dnd:b']);

    const recall = { nodes: [node('q', 'input'), node('r', 'memory', { key: 'dnd:{{vars.tableId}}' }), node('o', 'output')], edges: [edge('q', 'r'), edge('r', 'o')] };
    const a = await go(recall, 'x', { tableId: 'a' }, { memory });
    expect(a.result.final).toContain('The hag flees');
    expect(a.result.final).not.toContain('dragon');
    const b = await go(recall, 'x', { tableId: 'b' }, { memory });
    expect(b.result.final).toContain('The dragon wakes');
    expect(b.events.some((e) => e.type === 'node_progress' && e.note === 'Recalled 1 from "dnd:b"')).toBe(true);
  });
});
