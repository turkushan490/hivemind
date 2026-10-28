import type { ModelInfo } from '@hivemind/shared';
import { describe, expect, it } from 'vitest';
import { builderSystemPrompt, parseReply, toBuilderCanvas, toGraph } from '../src/builder/index.js';

const models: ModelInfo[] = [
  { providerId: 'ollama', model: 'small:1b', name: 'small', free: true, sizeBytes: 1.2e9 },
  { providerId: 'ollama', model: 'big:9b', name: 'big', free: true, sizeBytes: 5.6e9 },
  { providerId: 'ollama', model: 'cloud-stub:latest', name: 'stub', free: true, sizeBytes: 300 },
  { providerId: 'or', model: 'meta/llama:free', name: 'llama', free: true },
];

describe('builder', () => {
  it('lists only real models and leaves out cloud stubs', () => {
    const p = builderSystemPrompt(models);
    expect(p).toContain('- ollama|big:9b (free, local 5.6 GB, small)');
    expect(p).toContain('- ollama|small:1b (free, local 1.2 GB, tiny, fast but weak)');
    expect(p).toContain('- or|meta/llama:free (free, cloud)');
    expect(p).not.toContain('cloud-stub');
  });

  it('finds the JSON inside chatter and code fences', () => {
    const r = parseReply('Sure!\n```json\n{"reply":"Done","canvas":{"nodes":[],"edges":[]}}\n```');
    expect(r.reply).toBe('Done');
    expect(r.canvas).toEqual({ nodes: [], edges: [] });
    expect(parseReply('{"nodes":[{"id":"q","type":"input"}],"edges":[]}').canvas?.nodes).toHaveLength(1);
    expect(() => parseReply('no json here')).toThrow(/no JSON/);
    // Two objects in a row (seen from a 9B model): only the first counts; braces inside strings don't confuse it.
    expect(parseReply('{"reply":"use {{question}} \\"here\\"","canvas":null}\n{"reply":"second"}').reply).toBe('use {{question}} "here"');
  });

  it('puts an unwired "save" memory right before the final answer', () => {
    const { graph } = toGraph(
      {
        nodes: [
          { id: 'q', type: 'input' },
          { id: 'a', type: 'llm', model: 'ollama|small:1b' },
          { id: 'm', type: 'memory', key: 'council', mode: 'save' },
          { id: 'out', type: 'output' },
        ],
        edges: [['q', 'a'], ['a', 'out']],
      },
      models,
    );
    expect(graph.edges.map((e) => `${e.source}->${e.target}`).sort()).toEqual(['a->m', 'm->out', 'q->a']);
  });

  it('repairs a sloppy canvas into one that runs', () => {
    const { graph, fixes } = toGraph(
      {
        nodes: [
          { id: 'a', type: 'llm', label: 'Fast', model: 'ollama|small:1b' },
          { id: 'b', type: 'LLM', label: 'Made up', model: 'gpt-99' },
          { id: 'j', type: 'judge' },
          { id: 'x', type: 'teleporter' },
        ],
        edges: [
          ['a', 'j'],
          ['b', 'j'],
          ['j', 'a'], // would loop
          ['zz', 'j'], // unknown block
        ],
      },
      models,
    );
    const types = graph.nodes.map((n) => n.type).sort();
    expect(types).toEqual(['input', 'judge', 'llm', 'llm', 'output']);
    // Unknown model -> a real one; judge without a model -> the biggest local model that fits.
    expect(graph.nodes.find((n) => n.id === 'b')!.config.model).toEqual({ providerId: 'ollama', model: 'small:1b' });
    expect(graph.nodes.find((n) => n.id === 'j')!.config.model).toEqual({ providerId: 'ollama', model: 'big:9b' });
    expect(graph.edges.some((e) => e.source === 'j' && e.target === 'a')).toBe(false);
    // The question is wired into the members, the judge into the output.
    expect(graph.edges.map((e) => `${e.source}->${e.target}`)).toEqual(expect.arrayContaining(['q->a', 'q->b', 'j->out']));
    expect(fixes.join(' ')).toMatch(/teleporter/);
    // Laid out left to right.
    const x = (id: string) => graph.nodes.find((n) => n.id === id)!.position.x;
    expect(x('q')).toBeLessThan(x('a'));
    expect(x('a')).toBeLessThan(x('j'));
    expect(x('j')).toBeLessThan(x('out'));
  });

  it('round-trips a canvas through the compact shape', () => {
    const { graph } = toGraph(
      {
        nodes: [
          { id: 'q', type: 'input' },
          { id: 'd', type: 'debate', models: ['ollama|small:1b', 'ollama|big:9b'], rounds: 3 },
          { id: 'm', type: 'memory', key: 'notes', mode: 'save' },
          { id: 'out', type: 'output' },
        ],
        edges: [['q', 'd'], ['d', 'm'], ['m', 'out']],
      },
      models,
    );
    const compact = toBuilderCanvas(graph);
    expect(compact.nodes.find((n) => n.id === 'd')).toMatchObject({ models: ['ollama|small:1b', 'ollama|big:9b'], rounds: 3 });
    expect(compact.nodes.find((n) => n.id === 'm')).toMatchObject({ key: 'notes', mode: 'save' });
    expect(compact.edges).toEqual([['q', 'd'], ['d', 'm'], ['m', 'out']]);
  });
});

describe('builder: decisions', () => {
  const models = [
    { providerId: 'ollama', model: 'qwen3:8b', name: 'q', free: true, sizeBytes: 5e9 },
    { providerId: 'groq', model: 'llama-70b', name: 'l', free: true },
    { providerId: 'ts', model: 'jev-latest', name: 'jev', free: false, kind: 'decision' as const },
  ];

  it('knows the Decide block and decision models', () => {
    const sys = builderSystemPrompt(models);
    expect(sys).toMatch(/- decide: a DECISION model/);
    expect(sys).toContain('ts|jev-latest (DECISION model');
  });

  it('builds a spam filter with a Decide block and yes/no branches, and an Auto model block', () => {
    const { graph } = toGraph(
      {
        nodes: [
          { id: 'q', type: 'input' },
          { id: 'd', type: 'decide', model: 'ollama|qwen3:8b', questions: [{ name: 'spam', type: 'noul', instructions: 'Is this spam?' }] },
          { id: 'y', type: 'template', label: 'yes', prompt: 'spam' },
          { id: 'n', type: 'llm', label: 'no', auto: { small: 'ollama|qwen3:8b', large: 'groq|llama-70b' } },
          { id: 'out', type: 'output' },
        ],
        edges: [['q', 'd'], ['d', 'y'], ['d', 'n'], ['y', 'out'], ['n', 'out']],
      },
      models,
    );
    const d = graph.nodes.find((n) => n.type === 'decide')!;
    expect(d.config.model).toEqual({ providerId: 'ts', model: 'jev-latest' });
    expect(d.config.questions).toEqual([{ name: 'spam', type: 'noul', instructions: 'Is this spam?' }]);
    const auto = graph.nodes.find((n) => n.id === 'n')!.config.auto!;
    expect(auto.decider).toEqual({ providerId: 'ts', model: 'jev-latest' });
    expect(auto.large).toEqual({ providerId: 'groq', model: 'llama-70b' });
  });
});
