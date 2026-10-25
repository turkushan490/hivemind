import { anthropicAdapter } from './anthropic.js';
import { ollamaAdapter } from './ollama.js';
import { openaiAdapter } from './openai.js';
import type { ProviderAdapter, ProviderConfig } from './types.js';

export * from './types.js';

/** New provider kinds plug in here. */
export function createAdapter(cfg: ProviderConfig): ProviderAdapter {
  switch (cfg.kind) {
    case 'ollama':
      return ollamaAdapter(cfg);
    case 'openai':
      return openaiAdapter(cfg);
    case 'anthropic':
      return anthropicAdapter(cfg);
  }
}
