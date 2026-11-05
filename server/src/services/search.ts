import type { SearchSettings, SearchSource } from '@hivemind/shared';
import { decrypt, encrypt } from '../crypto.js';
import { getSetting, setSetting } from '../db/index.js';
import { checkUrl, readCapped } from './net.js';

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

/** Numeric entities (&#39; &#x27;) and the common named ones. */
const entities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const strip = (html: string) => entities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json', 'user-agent': 'HiveMind (+https://github.com/turkushan490/hivemind)', ...init?.headers } });
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

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Free and keyless: DuckDuckGo's HTML results (titles, links and snippets of the whole web). */
async function duckduckgo(q: string, count: number): Promise<SearchResult[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': BROWSER_UA, accept: 'text/html' },
    body: new URLSearchParams({ q, kl: 'wt-wt' }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo answered HTTP ${res.status}`);
  return parseDuckDuckGo(await res.text()).slice(0, count);
}

/** The results in DuckDuckGo's HTML page; its links go through /l/?uddg=<the real link>. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const block of html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1)) {
    const a = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, '&');
    const real = url.match(/[?&]uddg=([^&]+)/)?.[1];
    if (real) url = decodeURIComponent(real);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/)?.[1] ?? '';
    out.push({ title: strip(a[2]), url, text: strip(snippet) });
  }
  return out;
}

/**
 * The readable text of a web page (scripts, styles and tags taken out), at most maxChars. Only public addresses:
 * a search result can't make HiveMind read something in the local network.
 */
export async function readPage(url: string, maxChars = 6000): Promise<string> {
  // Redirects are followed by hand, so each hop is checked too (a public page can't redirect into the LAN).
  let next = url;
  let res: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    const u = await checkUrl(next, 'That page', { noPrivate: true });
    res = await fetch(u, { headers: { 'user-agent': BROWSER_UA, accept: 'text/html,text/plain;q=0.9' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!to) break;
    next = new URL(to, u).toString();
    res = undefined;
  }
  if (!res) throw new Error('too many redirects');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/|json|xml/.test(type)) throw new Error(`not a text page (${type.split(';')[0]})`);
  const body = (await readCapped(res, 3_000_000, 'That page')).toString('utf8');
  const text = /html/.test(type)
    ? entities(body
        .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<(br|p|div|li|h[1-6]|pre|tr)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ''))
    : body;
  return text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, maxChars);
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
    case 'duckduckgo':
      return duckduckgo(q, count);
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
