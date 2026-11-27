import { describe, expect, it } from 'vitest';
import { ollamaThink } from '../src/providers/ollama.js';
import { moreThinking, noThinking } from '../src/providers/openai.js';

/** The block's Thinking choice: off / on / think more, per provider. */
describe('thinking level', () => {
  it('Ollama: true/false, gpt-oss gets a level', () => {
    expect(ollamaThink(false, 'qwen3:8b')).toBe(false);
    expect(ollamaThink(true, 'qwen3:8b')).toBe(true);
    expect(ollamaThink('high', 'qwen3:8b')).toBe(true);
    expect(ollamaThink('high', 'gpt-oss:20b')).toBe('high');
    expect(ollamaThink(true, 'gpt-oss:20b')).toBe('medium');
    expect(ollamaThink(false, 'gpt-oss:20b')).toBe('low');
  });

  it('Think more maps to a high reasoning effort where the API has one', () => {
    expect(moreThinking('gemini', 'gemini-2.5-flash')).toBe('high');
    expect(moreThinking('openai', 'gpt-5-mini')).toBe('high');
    expect(moreThinking('openai', 'gpt-4o')).toBeUndefined();
    expect(noThinking('openai', 'gpt-4o')).toBeUndefined();
  });
});
