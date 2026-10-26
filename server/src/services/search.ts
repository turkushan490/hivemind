import type { SearchSettings, SearchSource } from '@hivemind/shared';
import { decrypt, encrypt } from '../crypto.js';
import { getSetting, setSetting } from '../db/index.js';

export interface SearchResult {
  title: string;
  url: string;
  text: string;
}

interface StoredSearch {
  source: SearchSource;
  wikiLang: string;
  searxngUrl?: string;
  braveKey?: string;
  tavilyKey?: string;
}

const KEY = 'search';

function load(): StoredSearch {
  try {
    return { source: 'wikipedia', wikiLang: 'en', ...JSON.parse(getSetting(KEY) ?? '{}') };
  } catch {
    return { source: 'wikipedia', wikiLang: 'en' };
  }
}

export function searchSettings(): SearchSettings {
  const s = load();
  return { source: s.source, wikiLang: s.wikiLang, searxngUrl: s.searxngUrl, hasBraveKey: !!s.braveKey, hasTavilyKey: !!s.tavilyKey };
}

/** Keys arrive in plain text and are stored encrypted; an empty string removes a key, undefined keeps it. */
export function saveSearchSettings(patch: Partial<SearchSettings> & { braveKey?: string; tavilyKey?: string }) {
  const s = load();
  const next: StoredSearch = {
    source: patch.source ?? s.source,
    wikiLang: (patch.wikiLang ?? s.wikiLang).trim() || 'en',
    searxngUrl: patch.searxngUrl !== undefined ? patch.searxngUrl.trim() || undefined : s.searxngUrl,
    braveKey: patch.braveKey !== undefined ? (patch.braveKey ? encrypt(patch.braveKey.trim()) : undefined) : s.braveKey,
    tavilyKey: patch.tavilyKey !== undefined ? (patch.tavilyKey ? encrypt(patch.tavilyKey.trim()) : undefined) : s.tavilyKey,
  };
  setSetting(KEY, JSON.stringify(next));
}

const strip = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, headers: { accept: 'application/json', 'user-agent': 'HiveMind (+https://github.com/turkushan490/hivemind)', ...init?.headers } });
  if (!res.ok) throw new Error(`Search answered HTTP ${res.status}`);
  return res.json() as Promise<any>;
}

/** Free and keyless: Wikipedia's own API, with the intro of each article. */
async function wikipedia(q: string, count: number, lang: string): Promise<SearchResult[]> {
  const url = new URL(`https://${encodeURIComponent(lang)}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: q,
    gsrlimit: String(count),
    prop: 'extracts|info',
    exintro: '1',
    explaintext: '1',
    exchars: '900',
    inprop: 'url',
  }))
    url.searchParams.set(k, v);
  const data = await json(url.toString());
  const pages = Object.values(data.query?.pages ?? {}) as { title: string; extract?: string; fullurl: string; index: number }[];
  return pages.sort((a, b) => a.index - b.index).map((p) => ({ title: p.title, url: p.fullurl, text: (p.extract ?? '').trim() }));
}

async function brave(q: string, count: number, key: string): Promise<SearchResult[]> {
  const data = await json(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`, { headers: { 'X-Subscription-Token': key } });
  return (data.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, text: strip(r.description ?? '') }));
}

async function tavily(q: string, count: number, key: string): Promise<SearchResult[]> {
  const data = await json('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query: q, max_results: count }),
  });
  return (data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, text: (r.content ?? '').slice(0, 900) }));
}

async function searxng(q: string, count: number, base: string): Promise<SearchResult[]> {
  const data = await json(`${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}&format=json`);
  return (data.results ?? []).slice(0, count).map((r: any) => ({ title: r.title, url: r.url, text: strip(r.content ?? '') }));
}

/** Runs a search with the block's source, or the default from Settings. */
export async function webSearch(q: string, opts: { source?: SearchSource; count?: number }): Promise<SearchResult[]> {
  const s = load();
  const source = opts.source ?? s.source;
  const count = Math.max(1, Math.min(10, opts.count ?? 5));
  switch (source) {
    case 'wikipedia':
      return wikipedia(q, count, s.wikiLang);
    case 'brave':
      if (!s.braveKey) throw new Error('Brave search needs an API key (Settings → Web search)');
      return brave(q, count, decrypt(s.braveKey));
    case 'tavily':
      if (!s.tavilyKey) throw new Error('Tavily search needs an API key (Settings → Web search)');
      return tavily(q, count, decrypt(s.tavilyKey));
    case 'searxng':
      if (!s.searxngUrl) throw new Error('SearXNG needs its address (Settings → Web search)');
      return searxng(q, count, s.searxngUrl);
  }
}
