import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

/** Agent block, agentWritePaths: it may only write the files it lists (the Prompt coach never touches the history). */

let app: FastifyInstance;
let mem: typeof import('../src/services/memoryFiles.js');
let agent: typeof import('../src/nodes/agent.js');

beforeAll(async () => {
  ({ app } = await testApp('agentwrite'));
  mem = await import('../src/services/memoryFiles.js');
  agent = await import('../src/nodes/agent.js');
});
afterAll(() => app.close());

function ctx(config: Record<string, unknown>, replies: string[]) {
  const sent: string[][] = [];
  const c = {
    node: { id: 'ag', type: 'agent', position: { x: 0, y: 0 }, config: { model: { providerId: 'p', model: 'm' }, ...config } },
    question: 'q',
    vars: {},
    inputs: [{ nodeId: 'q', type: 'input', label: 'Q', text: 'review' }],
    outgoing: [],
    callModel: async (messages: { content: string }[]) => {
      sent.push(messages.map((m) => m.content));
      return replies.shift() ?? '{"answer": "out of script"}';
    },
    choose: () => {},
    progress: () => {},
    say: () => {},
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
        move: (a: string, b: string) => mem.move('u1', a, b),
        remove: (p: string) => mem.remove?.('u1', p),
      },
    },
  };
  return { c: c as never, sent };
}

describe('Agent block: allowed files to write', () => {
  it('refuses other files and moves/deletes, writes the allowed ones', async () => {
    mem.write('u1', 'prompts/history.md', 'ENTRY ONE');
    const { c, sent } = ctx({ agentTools: ['readMemory', 'writeMemory'], agentWritePaths: 'prompts/lessons.md\nprompts/picture-lessons.md' }, [
      '{"tool": "writeMemory", "input": {"path": "prompts/history.md", "text": "wiped"}}',
      '{"tool": "writeMemory", "input": {"path": "prompts/lessons.md", "text": "{\\"from\\": \\"prompts/history.md\\", \\"to\\": \\"x.md\\"}"}}',
      '{"tool": "search", "input": {"query": "x"}}',
      '{"tool": "writeMemory", "input": {"path": "prompts/lessons.md", "text": "# Lessons for writing prompts\\n- Name the hair colour."}}',
      '{"answer": "Reviewed: ## Prompt 2026-11-27 10:00"}',
    ]);
    const out = await agent.AGENT_NODE.execute(c);
    expect(out).toContain('Reviewed:');
    const all = sent.flat().join('\n');
    expect(all).toContain('You may only write: prompts/lessons.md, prompts/picture-lessons.md');
    expect(all).toContain('Moving or deleting files is not allowed here');
    expect(all).toContain('"search" is not one of your tools');
    expect(mem.read('u1', ['prompts/history.md'])[0].content).toBe('ENTRY ONE');
    expect(mem.read('u1', ['prompts/lessons.md'])[0].content).toContain('Name the hair colour');
  });
});
