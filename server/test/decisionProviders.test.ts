import { afterEach, describe, expect, it, vi } from 'vitest';
import { decisionAdapter, SPAM_TEST } from '../src/providers/decisions.js';
import { knownPrice } from '../src/services/pricing.js';

afterEach(() => vi.unstubAllGlobals());

/** Records each request and answers with reply(body). */
function mockFetch(reply: (url: string, body: any, headers: Record<string, string>) => unknown, status = 200) {
  const seen: { url: string; body: any; headers: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, body, headers });
    const out = reply(url, body, headers);
    return typeof out === 'string' ? new Response(out, { status }) : Response.json(out, { status });
  });
  return seen;
}

const cfg = (preset: string, baseUrl: string, apiKey?: string) => ({ id: preset, kind: 'decision' as const, preset, baseUrl, apiKey });

describe('TypeSafe Jev adapter', () => {
  it('sends /v1/systemone with the questions as-is and maps noul / choice / score', async () => {
    const seen = mockFetch(() => ({
      model: 'jev-1.14.0',
      answers: {
        spam: { type: 'noul', noul: 0.96 },
        wants: { type: 'choice', choice: 'promote something', probabilities: { 'promote something': 1, 'ask a question': 0, 'say thanks': 0 }, confidence: 0.9 },
        positive: { type: 'score', score: 1.58, legend: { 0: 'Negative', 1: 'Neutral', 2: 'Positive' }, probabilities: { 0: 0.02, 1: 0.38, 2: 0.6 }, confidence: 0.5 },
      },
      usage: { input_tokens: 529, output_tokens: 141 },
    }));
    const r = await decisionAdapter(cfg('typesafe', 'https://api.typesafe.ai', 'k')).decide!({ model: 'jev-latest', state: 'buy now', questions: SPAM_TEST });
    expect(seen[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen[0].headers.authorization).toBe('Bearer k');
    expect(seen[0].body).toEqual({ model: 'jev-latest', state: 'buy now', questions: SPAM_TEST });
    expect(r.answers.spam).toEqual({ type: 'noul', p: 0.96 });
    expect(r.answers.wants).toMatchObject({ type: 'choice', choice: 'promote something' });
    expect(r.answers.positive).toMatchObject({ type: 'score', score: 1.58, probabilities: { 2: 0.6 } });
    expect(r.usage).toEqual({ inputTokens: 529, outputTokens: 141 });
    expect(r.model).toBe('jev-1.14.0');
  });

  it('box questions send the image as an asset with the danger-zone header, and read the edges', async () => {
    const seen = mockFetch(() => ({ model: 'jev-1.14.0', answers: { mug: { type: 'box', box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.6 }, confidence: 0.9 } }, usage: { input_tokens: 900 } }));
    const png = Buffer.from('89504e470d0a1a0a00', 'hex');
    const r = await decisionAdapter(cfg('typesafe', 'https://api.typesafe.ai', 'k')).decide!({
      model: 'jev-1.14.0',
      state: 'a kitchen',
      questions: { mug: { type: 'box', instructions: 'the coffee mug' } },
      images: [{ data: png, ext: 'png' }],
    });
    expect(seen[0].headers['typesafe-danger-zone-images']).toBe('true');
    expect(seen[0].body.assets['hm-image-1']).toEqual({ type: 'image', format: 'png', data_base64: png.toString('base64') });
    expect(JSON.stringify(seen[0].body.state)).toContain('hm-image-1');
    expect(seen[0].body.questions.mug).toEqual({ type: 'box', instructions: 'the coffee mug' });
    expect(r.answers.mug).toEqual({ type: 'box', box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.6 }, confidence: 0.9 });
  });

  it('a 401 becomes a readable error', async () => {
    mockFetch(() => '{"detail":"invalid api key"}', 401);
    await expect(decisionAdapter(cfg('typesafe', 'https://api.typesafe.ai')).decide!({ model: 'jev-latest', state: 'x', questions: SPAM_TEST })).rejects.toThrow(
      /TypeSafe \(Jev\) answered HTTP 401 — the API key is missing or wrong/,
    );
  });

  it('lists models as decision models with the Jev price', async () => {
    mockFetch(() => ({ models: [{ name: 'jev-latest', description: '', release_date: '' }] }));
    const models = await decisionAdapter(cfg('typesafe', 'https://api.typesafe.ai', 'k')).listModels();
    expect(models.every((m) => m.kind === 'decision')).toBe(true);
    expect(models.map((m) => m.model)).toEqual(['jev-latest', 'jev-1.14.0']);
    expect(models[0].price).toEqual({ input: 0.042, output: 0 });
    expect(knownPrice('jev-1.14.0')).toEqual({ input: 0.042, output: 0 });
  });
});

describe('Ollama decision models adapter', () => {
  it('uses the local /v1/systemone shape with base64 images and no key', async () => {
    const seen = mockFetch(() => ({ model: 'clef-flash', answers: { has: { type: 'noul', noul: 0.959 } }, usage: { input_tokens: 677, output_tokens: 0 } }));
    const r = await decisionAdapter(cfg('ollama-decisions', 'http://gpu:11434')).decide!({
      model: 'clef-flash',
      state: 'screenshot',
      questions: { has: { type: 'noul', instructions: 'Does this image contain Ollama?' } },
      images: [{ data: Buffer.from('abc'), ext: 'png' }],
    });
    expect(seen[0].url).toBe('http://gpu:11434/v1/systemone');
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].body.images).toEqual([Buffer.from('abc').toString('base64')]);
    expect(r.answers.has).toEqual({ type: 'noul', p: 0.959 });
  });

  it('lists only the decision model families from /api/tags', async () => {
    mockFetch(() => ({ models: [{ name: 'nimble:latest', size: 5e9 }, { name: 'qwen3:8b' }, { name: 'tev1:0.8b' }] }));
    const models = await decisionAdapter(cfg('ollama-decisions', 'http://gpu:11434')).listModels();
    expect(models.map((m) => m.model)).toEqual(['nimble:latest', 'tev1:0.8b']);
    expect(models[0]).toMatchObject({ kind: 'decision', free: true });
  });

  it('refuses box questions with a clear message', async () => {
    mockFetch(() => ({}));
    await expect(
      decisionAdapter(cfg('ollama-decisions', 'http://gpu:11434')).decide!({ model: 'nimble', state: 'x', questions: { b: { type: 'box', instructions: 'x' } }, images: [{ data: Buffer.from('x'), ext: 'png' }] }),
    ).rejects.toThrow(/Box questions need TypeSafe Jev 1.14/);
  });
});

describe('OpenAI Decisions adapter', () => {
  it('maps noul ⇄ predicate, choice criteria → choices[], score criteria → levels[], and the answer list back', async () => {
    const seen = mockFetch(() => ({
      model: 'gpt-6-luna',
      answers: [
        { name: 'spam', type: 'predicate', probability: 0.91 },
        { name: 'wants', type: 'choice', choice: 'promote something', confidence: 0.8, probabilities: [{ value: 'promote something', probability: 0.85 }, { value: 'say thanks', probability: 0.15 }] },
        { name: 'positive', type: 'score', score: 0.4, confidence: 0.7, probabilities: [{ label: 'Negative', value: 0, probability: 0.6 }, { label: 'Neutral', value: 1, probability: 0.4 }] },
      ],
      usage: { input_tokens: 300, output_tokens: 3, total_tokens: 303 },
    }));
    const r = await decisionAdapter(cfg('openai-decisions', 'https://api.openai.com/v1', 'sk')).decide!({ model: 'gpt-6-luna', state: 'buy now', questions: SPAM_TEST });
    expect(seen[0].url).toBe('https://api.openai.com/v1/decisions');
    expect(seen[0].body.input).toBe('buy now');
    expect(seen[0].body.questions[0]).toEqual({ name: 'spam', type: 'predicate', instructions: 'Is this YouTube comment spam?' });
    expect(seen[0].body.questions[1].choices[0]).toEqual({ value: 'ask a question', description: 'Ask a real question about the video' });
    expect(seen[0].body.questions[2].levels).toEqual([{ label: 'Negative' }, { label: 'Neutral' }, { label: 'Positive' }]);
    expect(r.answers.spam).toEqual({ type: 'noul', p: 0.91 });
    expect(r.answers.wants).toMatchObject({ type: 'choice', choice: 'promote something', probabilities: { 'promote something': 0.85, 'say thanks': 0.15 } });
    expect(r.answers.positive).toMatchObject({ type: 'score', score: 0.4, probabilities: { 0: 0.6, 1: 0.4 } });
    expect(r.usage.inputTokens).toBe(300);
  });

  it('sends images as input_image parts and keeps refusals', async () => {
    const seen = mockFetch(() => ({ answers: [{ name: 'spam', type: 'refusal' }], usage: { input_tokens: 1, output_tokens: 0 } }));
    const r = await decisionAdapter(cfg('openai-decisions', 'https://api.openai.com/v1', 'sk')).decide!({
      model: 'gpt-6-luna',
      state: 's',
      questions: { spam: { type: 'noul', instructions: 'x' } },
      images: [{ data: Buffer.from([0xff, 0xd8, 0xff]), ext: 'jpg' }],
    });
    expect(seen[0].body.input[0].content[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(r.answers.spam).toEqual({ type: 'refusal' });
  });
});
