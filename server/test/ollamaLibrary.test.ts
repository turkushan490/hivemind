import { describe, expect, it } from 'vitest';
import { estimateBytes, paramsOf, parseLibrary, parseSearch, parseTags, recentPopularity } from '../src/api/ollamaLibrary.js';

// Trimmed copies of ollama.com's markup (search results and the tags page).
const SEARCH = `
<ul role="list">
<li  class="border-b">
  <a href="/library/qwen3.8" class="group flex">
    <h2 title="qwen3.8"><span >qwen3.8</span></h2>
    <p class="mt-1" title="Qwen3.8 delivers gains &amp; more.">Qwen3.8 delivers gains &amp; more.</p>
    <div class="mt-3"><span  class="inline-flex items-center rounded-md bg-indigo-50">vision</span><span  class="inline-flex items-center rounded-md bg-indigo-50">tools</span>
      <span  class="inline-flex items-center rounded-md bg-[#ddf4ff]">4b</span><span  class="inline-flex items-center rounded-md bg-[#ddf4ff]">27b</span>
    </div>
    <span class="inline-flex" title="4,898,205 downloads"><span >4.9M</span></span>
  </a>
</li>
<li  class="border-b">
  <a href="/library/big-cloud" class="group flex">
    <p class="mt-1" title="Cloud only">Cloud only</p>
    <div><span  class="inline-flex items-center rounded-md bg-indigo-50">cloud</span></div>
    <span class="inline-flex" title="12 downloads"></span>
  </a>
</li>
</ul>`;

const TAGS = `
<a href="/library/qwen3:latest" class="md:hidden flex flex-col">
  <span>qwen3:latest</span>
  <span class="font-mono">500a1f067a9f</span> • 5.2GB • 40K context window •
  <span class="hidden sm:inline">Text input • 1 year ago</span>
</a>
<div class="hidden md:flex"><a href="/library/qwen3:latest">qwen3:latest</a></div>
<a href="/library/qwen3:0.6b" class="md:hidden flex flex-col">
  <span class="font-mono">7df6b6e09427</span> • 523MB • 40K context window • Text input
</a>
<a href="/library/qwen3:480b-cloud" class="md:hidden flex flex-col">
  <span class="font-mono">abc</span> • 256K context window • Text input
</a>`;

describe('ollama.com parsing', () => {
  it('reads search results', () => {
    const [m, cloud] = parseSearch(SEARCH);
    expect(m).toEqual({
      name: 'qwen3.8',
      description: 'Qwen3.8 delivers gains & more.',
      capabilities: ['vision', 'tools'],
      sizes: ['4b', '27b'],
      downloads: 4898205,
      cloudOnly: false,
    });
    expect(cloud.cloudOnly).toBe(true);
  });

  it('reads tags with sizes and skips cloud tags', () => {
    expect(parseTags('qwen3', TAGS)).toEqual([
      { tag: 'qwen3:latest', sizeBytes: 5.2e9, context: '40K', input: 'Text' },
      { tag: 'qwen3:0.6b', sizeBytes: 523e6, context: '40K', input: 'Text' },
    ]);
  });

  it('turns parameter sizes into rough download sizes', () => {
    expect(paramsOf('8b')).toBe(8e9);
    expect(paramsOf('0.6b')).toBe(6e8);
    expect(paramsOf('270m')).toBe(2.7e8);
    expect(paramsOf('8x7b')).toBe(56e9);
    expect(paramsOf('e4b')).toBe(4e9);
    expect(paramsOf('latest')).toBeUndefined();
    // qwen3:8b is really 5.2 GB
    expect(estimateBytes(8e9) / 1e9).toBeCloseTo(5.1, 0);
  });

  it('reads the library page and prefers recent models', () => {
    const entry = (name: string, pulls: string, date: string) => `
<li  class="flex">
  <a href="/library/${name}" class="group">
    <p class="max-w-lg break-words text-md">${name} model</p>
    <span  class="inline-flex items-center rounded-md bg-indigo-50">tools</span>
    <span  class="inline-flex items-center rounded-md bg-[#ddf4ff]">8b</span>
    <span >${pulls}</span>
    <span class="hidden sm:flex">&nbsp;Pulls</span>
    <span class="flex items-center" title="${date} 8:18 PM UTC"></span>
  </a>
</li>`;
    const lib = parseLibrary(entry('llama2', '5.1M', 'Jan 1, 2024') + entry('qwen9', '1.2M', 'Oct 1, 2026') + entry('qwen9', '1.2M', 'Oct 1, 2026'));
    expect(lib.map((m) => m.name)).toEqual(['llama2', 'qwen9']);
    expect(lib[0]).toMatchObject({ downloads: 5_100_000, sizes: ['8b'], capabilities: ['tools'], description: 'llama2 model' });
    const now = Date.parse('2026-10-25T00:00:00Z');
    expect(recentPopularity(lib[1], now)).toBeGreaterThan(recentPopularity(lib[0], now));
  });
});
