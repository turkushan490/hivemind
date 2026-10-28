/**
 * Prices of paid cloud models, in USD per 1M tokens, for providers whose model list has no prices
 * (OpenAI, Anthropic). OpenRouter sends its own prices with the model list, which win over this table;
 * free models (Ollama, ":free", free-tier presets) always count as 0.
 *
 * Matching: the model id (without a "vendor/" prefix) is compared with each key; the longest key
 * that the id starts with wins, so "gpt-4o-mini-2024-07-18" gets "gpt-4o-mini", not "gpt-4o".
 * Prices change: edit this table when they do.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  o1: { input: 15, output: 60 },
  'o1-mini': { input: 1.1, output: 4.4 },
  o3: { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // Anthropic
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  // TypeSafe Jev (decision model): input tokens only, output is free
  jev: { input: 0.042, output: 0 },
};

const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** The table price for a model id, or undefined when unknown. */
export function knownPrice(model: string): { input: number; output: number } | undefined {
  const id = model.toLowerCase().split('/').pop()!;
  const key = KEYS.find((k) => id === k || id.startsWith(`${k}-`) || id.startsWith(`${k}:`) || id.startsWith(`${k}.`));
  return key ? PRICES[key] : undefined;
}

/** USD for one call, or undefined when the price is unknown. */
export function callCost(info: { free?: boolean; price?: { input: number; output: number } } | undefined, model: string, inputTokens: number, outputTokens: number): number | undefined {
  if (info?.free) return 0;
  const price = info?.price ?? knownPrice(model);
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1e6 : undefined;
}
