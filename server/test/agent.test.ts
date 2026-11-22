import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

let app: FastifyInstance;
let mem: typeof import('../src/services/memoryFiles.js');
let agent: typeof import('../src/nodes/agent.js');

beforeAll(async () => {
  ({ app } = await testApp('agent'));
  mem = await import('../src/services/memoryFiles.js');
  agent = await import('../src/nodes/agent.js');
});
afterAll(() => app.close());

/** An agent block whose "model" answers from a script, one reply per call; records what it was sent. */
function ctx(config: Record<string, unknown>, replies: string[], extra: Record<string, unknown> = {}) {
  const sent: string[][] = [];
  const notes: string[] = [];
  const said: string[] = [];
  const c = {
    node: { id: 'ag', type: 'agent', position: { x: 0, y: 0 }, config: { model: { providerId: 'p', model: 'm' }, ...config } },
    question: 'q',
    vars: { character: 'ultron' },
    inputs: [{ nodeId: 'q', type: 'input', label: 'Q', text: 'Remember that the shop opens at 9.' }],
    outgoing: [],
    callModel: async (messages: { content: string }[]) => {
      sent.push(messages.map((m) => m.content));
      return replies.shift() ?? '{"answer": "out of script"}';
    },
    choose: () => {},
    progress: (n: string) => notes.push(n),
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
        move: (a: string, b: string) => mem.move('u1', a, b),
      },
      ...extra,
    },
  };
  return { c: c as never, sent, notes, said };
}

describe('Agent block (H21)', () => {
  it('reads a step as JSON, also inside a ```json block', () => {
    expect(agent.parseStep('{"tool": "search", "input": {"query": "x"}}')).toEqual({ tool: 'search', input: { query: 'x' } });
    expect(agent.parseStep('Sure!\n```json\n{"answer": "done"}\n```')).toEqual({ answer: 'done' });
    expect(agent.parseStep('no json here')).toBeUndefined();
  });

  it('uses tools in turns, sees each result, and answers; every step shows on the block', async () => {
    const { c, sent, notes, said } = ctx({ agentTools: ['writeMemory', 'readMemory', 'sayNow'], agentLog: true }, [
      '{"tool": "sayNow", "input": {"text": "On it."}}',
      '{"tool": "writeMemory", "input": {"path": "topics/shop.md", "text": "The shop opens at 9."}}',
      'I will read it back now',
      '{"tool": "readMemory", "input": {"paths": ["topics/shop.md"]}}',
      '{"answer": "Saved: the shop opens at 9."}',
    ]);
    const out = await agent.AGENT_NODE.execute(c);
    expect(out).toMatch(/^Saved: the shop opens at 9\./);
    expect(out).toContain('2. writeMemory');
    expect(said).toEqual(['On it.']);
    expect(mem.read('u1', ['topics/shop.md'])[0].content).toBe('The shop opens at 9.');
    // The system prompt lists only the allowed tools; the model saw the read-back result.
    expect(sent[0][0]).toContain('- writeMemory:');
    expect(sent[0][0]).not.toContain('- shell:');
    expect(sent.at(-1)!.join('\n')).toContain('Result of readMemory:\nFile topics/shop.md:\nThe shop opens at 9.');
    expect(notes.some((n) => /step 3: not JSON/.test(n))).toBe(true);
    expect(notes.some((n) => n.startsWith('step 2: writeMemory'))).toBe(true);
  });

  it('the same tool call three times in a row is stopped (H29)', async () => {
    const same = '{"tool": "readMemory", "input": {"paths": ["x.md"]}}';
    const { c, sent } = ctx({ agentTools: ['readMemory'] }, [same, same, same, '{"answer": "ok"}']);
    expect(await agent.AGENT_NODE.execute(c)).toBe('ok');
    expect(sent[3].at(-1)).toMatch(/Do not repeat it/);
  });

  it('a tool that is not allowed comes back as an error the model can read', async () => {
    const { c, sent } = ctx({ agentTools: ['readMemory'] }, ['{"tool": "shell", "input": {"commands": "ls"}}', '{"answer": "I may not run commands."}']);
    expect(await agent.AGENT_NODE.execute(c)).toBe('I may not run commands.');
    expect(sent[1].at(-1)).toMatch(/ERROR: "shell" is not one of your tools/);
  });

  it('asks a teammate through the HiveBot canvas, and stops at maxSteps', async () => {
    const asked: Record<string, string>[] = [];
    const askCanvas = async (o: { canvas: string; question: string; vars: Record<string, string> }) => {
      asked.push({ canvas: o.canvas, q: o.question, who: o.vars.character, from: o.vars.from });
      return 'Jarvis: the clicker needs a Shop button.';
    };
    const { c } = ctx({ agentTools: ['askCharacter'], maxSteps: 2 }, [
      '{"tool": "askCharacter", "input": {"character": "Jarvis", "question": "What is missing?"}}',
      '{"tool": "askCharacter", "input": {"character": "jev", "question": "And you?"}}',
      '{"answer": "Jarvis says: add a Shop button."}',
    ], { askCanvas });
    expect(await agent.AGENT_NODE.execute(c)).toBe('Jarvis says: add a Shop button.');
    expect(asked[0]).toEqual({ canvas: 'hivebot', q: 'What is missing?', who: 'jarvis', from: 'ultron' });
    expect(asked).toHaveLength(2);
  });
});
