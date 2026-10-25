import type { OllamaLibraryModel, OllamaTag } from '@hivemind/shared';

// ollama.com has no public search API; its search and tags pages are plain server-rendered HTML.
// Parsing is kept loose so small layout changes degrade to fewer details instead of errors.

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** "8b" → 8e9 parameters, "0.6b" → 6e8, "270m" → 2.7e8, "e2b"/"8x7b" → best effort. */
export function paramsOf(size: string): number | undefined {
  const m = size.toLowerCase().match(/^(?:(\d+)x)?e?(\d+(?:\.\d+)?)([bm])$/);
  if (!m) return;
  const n = Number(m[2]) * (m[3] === 'b' ? 1e9 : 1e6);
  return m[1] ? n * Number(m[1]) : n;
}

/** Rough Q4 download size: ~0.6 bytes per parameter plus overhead. Exact sizes come from the tags page. */
export const estimateBytes = (params: number) => Math.round(params * 0.6 + 0.3e9);

export function parseSearch(html: string): OllamaLibraryModel[] {
  const out: OllamaLibraryModel[] = [];
  for (const li of html.split('<li').slice(1)) {
    const name = li.match(/href="\/library\/([\w.\-]+)"/)?.[1];
    if (!name) continue;
    const description = decode(li.match(/<p[^>]*title="([^"]*)"/)?.[1] ?? '');
    const chips = [...li.matchAll(/<span\s+class="[^"]*rounded-md[^"]*">([^<]+)<\/span>/g)].map((m) => m[1].trim());
    const sizes = chips.filter((c) => /^(?:\d+x)?e?\d+(?:\.\d+)?[bm]$/i.test(c));
    const capabilities = chips.filter((c) => !sizes.includes(c));
    const downloads = Number(li.match(/title="([\d,]+) downloads"/)?.[1]?.replace(/,/g, '') ?? 0);
    out.push({ name, description, capabilities, sizes, downloads, cloudOnly: sizes.length === 0 && capabilities.includes('cloud') });
  }
  return out;
}

/** "41.5M" → 41_500_000 */
const pulls = (s: string) => {
  const m = s.trim().match(/^([\d.]+)\s*([KMB]?)$/i);
  return m ? Math.round(Number(m[1]) * ({ '': 1, K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'B'] ?? 1)) : 0;
};

/** The /library page: every model, by all-time pulls, with its last update date. */
export function parseLibrary(html: string): OllamaLibraryModel[] {
  const out: OllamaLibraryModel[] = [];
  for (const li of html.split('<li').slice(1)) {
    const name = li.match(/href="\/library\/([\w.\-]+)"/)?.[1];
    if (!name || out.some((m) => m.name === name)) continue;
    const description = decode(li.match(/<p class="max-w-lg[^"]*">([^<]*)<\/p>/)?.[1]?.trim() ?? '');
    const chips = [...li.matchAll(/<span\s+class="[^"]*rounded-md[^"]*">([^<]+)<\/span>/g)].map((m) => m[1].trim());
    const sizes = chips.filter((c) => /^(?:\d+x)?e?\d+(?:\.\d+)?[bm]$/i.test(c));
    const capabilities = chips.filter((c) => !sizes.includes(c));
    const downloads = pulls(li.match(/<span >([\d.]+[KMB]?)<\/span>\s*<span class="hidden sm:flex">&nbsp;Pulls/)?.[1] ?? '0');
    const updated = li.match(/title="([A-Z][a-z]{2} \d{1,2}, \d{4})[^"]*UTC"/)?.[1];
    out.push({
      name,
      description,
      capabilities,
      sizes,
      downloads,
      cloudOnly: sizes.length === 0 && capabilities.includes('cloud'),
      updatedAt: updated ? new Date(`${updated} UTC`).toISOString() : undefined,
    });
  }
  return out;
}

/** Popularity that favours current models: all-time pulls, discounted by how long ago the model was updated. */
export function recentPopularity(m: OllamaLibraryModel, now = Date.now()): number {
  if (!m.updatedAt) return m.downloads * 0.1;
  const months = (now - Date.parse(m.updatedAt)) / (30 * 86400_000);
  const factor = months <= 6 ? 1 : months <= 12 ? 0.5 : months <= 24 ? 0.15 : 0.03;
  return m.downloads * factor;
}

export function parseTags(name: string, html: string): OllamaTag[] {
  const tags = new Map<string, OllamaTag>();
  // The mobile row of each tag holds "<digest> • 5.2GB • 40K context window • Text input".
  const re = new RegExp(`href="/library/(${name.replace(/[.\-]/g, '\\$&')}:[^"]+)"[^>]*class="md:hidden[\\s\\S]*?</a>`, 'g');
  for (const m of html.matchAll(re)) {
    const block = m[0];
    const tag = m[1];
    const size = block.match(/(\d+(?:\.\d+)?)\s*(GB|MB|TB)\b/);
    if (!size) continue; // cloud tags have no download
    const mult = { MB: 1e6, GB: 1e9, TB: 1e12 }[size[2] as 'MB' | 'GB' | 'TB'];
    tags.set(tag, {
      tag,
      sizeBytes: Math.round(Number(size[1]) * mult),
      context: block.match(/(\d+[KM]) context/)?.[1],
      input: block.match(/(Text(?:, Image)?(?:, Audio)?) input/)?.[1],
    });
  }
  return [...tags.values()];
}

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return value;
}

async function page(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: 'text/html', 'user-agent': 'HiveMind (+https://github.com/turkushan490/hivemind)' } });
  if (!res.ok) throw Object.assign(new Error(`ollama.com answered HTTP ${res.status}`), { statusCode: 502 });
  return res.text();
}

/** Empty query: the whole library, most popular (recent) first. Otherwise ollama.com's own search. */
export const searchLibrary = (q: string) =>
  q
    ? cached(`s:${q}`, 10 * 60_000, async () => parseSearch(await page(`https://ollama.com/search?q=${encodeURIComponent(q)}`)))
    : cached('library', 60 * 60_000, async () =>
        parseLibrary(await page('https://ollama.com/library')).sort((a, b) => recentPopularity(b) - recentPopularity(a)),
      );

export const libraryTags = (name: string) =>
  cached(`t:${name}`, 60 * 60_000, async () => parseTags(name, await page(`https://ollama.com/library/${encodeURIComponent(name)}/tags`)));
