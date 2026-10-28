import type { CanvasNode, NodeConfig, NodeType } from '@hivemind/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fillTemplate } from '../src/nodes/actions.js';
import { NODES, type NodeContext, type NodeServices } from '../src/nodes/index.js';

// No real DNS in tests: names resolve to a public address, "*.internal" to a LAN one, "*.loop" to loopback.
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => [{ address: host.endsWith('.internal') ? '192.168.1.50' : host.endsWith('.loop') ? '127.0.0.1' : '93.184.216.34', family: 4 }],
}));

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BLOCK_PRIVATE_ADDRESSES;
});

const HA = { url: 'http://ha.local:8123', token: 'llat' };

function ctx(type: NodeType, config: NodeConfig, opts: { input?: string; services?: NodeServices } = {}) {
  const notes: string[] = [];
  const node: CanvasNode = { id: 'n', type, position: { x: 0, y: 0 }, config };
  const c: NodeContext = {
    node,
    question: 'Is it warm?',
    vars: {},
    inputs: [
      { nodeId: 'q', type: 'input', label: 'Question', text: 'Is it warm?' },
      ...(opts.input !== undefined ? [{ nodeId: 'a', type: 'llm' as const, label: 'Model', text: opts.input }] : []),
    ],
    outgoing: [],
    callModel: async () => '',
    decide: async () => Promise.reject(new Error('no decisions here')),
    choose: () => {},
    progress: (n) => notes.push(n),
    generateImage: async () => [],
    attach: () => {},
    services: opts.services ?? { homeAssistant: () => HA },
  };
  return { c, notes };
}

/** A fetch mock answering from a list, recording what was sent. */
function mockFetch(...answers: Response[]) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => answers.shift() ?? new Response('', { status: 500 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('fillTemplate', () => {
  const c = { question: 'Q "x"', inputs: [{ nodeId: 'a', type: 'llm' as const, label: 'A', text: 'line1\nline "2"' }] };
  it('fills text templates as is', () => {
    expect(fillTemplate('{{question}} -> {{input}}', c)).toBe('Q "x" -> line1\nline "2"');
  });
  it('escapes values inside JSON templates', () => {
    const out = fillTemplate('{"msg": "{{input}}", "q": "{{ question }}"}', c);
    expect(JSON.parse(out)).toEqual({ msg: 'line1\nline "2"', q: 'Q "x"' });
  });
});

describe('Home Assistant block', () => {
  it('reads entity states with the token', async () => {
    const fetch = mockFetch(json({ entity_id: 'sensor.temp', state: '21.5', attributes: { friendly_name: 'Living room', unit_of_measurement: '°C' } }));
    const { c } = ctx('homeassistant', { haOp: 'state', entities: 'sensor.temp' });
    const out = await NODES.homeassistant.execute(c);
    expect(out).toBe('sensor.temp (Living room): 21.5 — unit_of_measurement °C');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://ha.local:8123/api/states/sensor.temp');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer llat');
  });

  it('calls a service with templated JSON data', async () => {
    const fetch = mockFetch(json([{ entity_id: 'notify.phone', state: 'ok' }]));
    const { c } = ctx('homeassistant', { haOp: 'service', service: 'notify.mobile_app', body: '{"message": "{{input}}"}' }, { input: 'Say "hi"\nnow' });
    const out = await NODES.homeassistant.execute(c);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://ha.local:8123/api/services/notify/mobile_app');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ message: 'Say "hi"\nnow' });
    expect(out).toContain('Called notify.mobile_app');
  });

  it('takes the service from the AI answer when none is set', async () => {
    const fetch = mockFetch(json([]));
    const { c } = ctx('homeassistant', { haOp: 'service' }, { input: '```json\n{"service": "light.turn_off", "data": {"entity_id": "light.kitchen"}}\n```' });
    expect(await NODES.homeassistant.execute(c)).toBe('Called light.turn_off.');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://ha.local:8123/api/services/light/turn_off');
    expect(JSON.parse(init!.body as string)).toEqual({ entity_id: 'light.kitchen' });
  });

  it('fails clearly when not connected, on a wrong token or a missing entity', async () => {
    await expect(NODES.homeassistant.execute(ctx('homeassistant', { entities: 'light.x' }, { services: {} }).c)).rejects.toThrow(/not connected/);
    mockFetch(new Response('401: Unauthorized', { status: 401 }));
    await expect(NODES.homeassistant.execute(ctx('homeassistant', { entities: 'light.x' }).c)).rejects.toThrow(/HTTP 401 — check the token/);
    mockFetch(new Response('', { status: 404 }));
    await expect(NODES.homeassistant.execute(ctx('homeassistant', { entities: 'light.x' }).c)).rejects.toThrow(/no entity "light.x"/);
    await expect(NODES.homeassistant.execute(ctx('homeassistant', { haOp: 'service', service: 'nope' }).c)).rejects.toThrow(/domain.service/);
  });

  it('reports an unreachable Home Assistant', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))));
    await expect(NODES.homeassistant.execute(ctx('homeassistant', { entities: 'light.x' }).c)).rejects.toThrow(/Can't reach Home Assistant .*ECONNREFUSED/);
  });
});

describe('Webhook block', () => {
  it('sends method, headers and body, and passes the response on', async () => {
    const fetch = mockFetch(json({ ok: true, id: 7 }));
    const { c, notes } = ctx('webhook', { url: 'https://example.com/hook', method: 'PUT', headers: 'X-Key: abc\nX-Q: {{question}}', body: '{"text": "{{input}}"}' }, { input: 'hello' });
    const out = await NODES.webhook.execute(c);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(init!.method).toBe('PUT');
    expect(init!.headers).toMatchObject({ 'x-key': 'abc', 'x-q': 'Is it warm?', 'content-type': 'application/json' });
    expect(JSON.parse(init!.body as string)).toEqual({ text: 'hello' });
    expect(JSON.parse(out)).toEqual({ ok: true, id: 7 });
    expect(notes.at(-1)).toMatch(/HTTP 200/);
  });

  it('sends no body on GET', async () => {
    const fetch = mockFetch(new Response('plain answer'));
    expect(await NODES.webhook.execute(ctx('webhook', { url: 'http://x.local/a?q={{question}}', method: 'GET' }).c)).toBe('plain answer');
    expect(fetch.mock.calls[0][0]).toBe('http://x.local/a?q=Is%20it%20warm%3F');
    expect(fetch.mock.calls[0][1]!.body).toBeUndefined();
  });

  it('fails on bad URLs, bad JSON and error statuses', async () => {
    await expect(NODES.webhook.execute(ctx('webhook', {}).c)).rejects.toThrow(/Fill in the URL/);
    await expect(NODES.webhook.execute(ctx('webhook', { url: 'https://x.io', body: '{"a": {{input}}}' }, { input: 'not json' }).c)).rejects.toThrow(/not valid JSON/);
    mockFetch(new Response('boom', { status: 500 }));
    await expect(NODES.webhook.execute(ctx('webhook', { url: 'https://x.io' }).c)).rejects.toThrow(/x.io answered HTTP 500: boom/);
  });

  it('never calls cloud metadata or loopback, and the LAN only when allowed', async () => {
    const fetch = mockFetch(new Response('ok'), new Response('ok'));
    await expect(NODES.webhook.execute(ctx('webhook', { url: 'http://169.254.169.254/latest/meta-data' }).c)).rejects.toThrow(/cloud-metadata/);
    await expect(NODES.webhook.execute(ctx('webhook', { url: 'http://[::1]:4820/api' }).c)).rejects.toThrow(/loopback/);
    await expect(NODES.webhook.execute(ctx('webhook', { url: 'http://me.loop/api' }).c)).rejects.toThrow(/loopback/);
    expect(await NODES.webhook.execute(ctx('webhook', { url: 'http://nas.internal/hook', method: 'GET' }).c)).toBe('ok');
    process.env.BLOCK_PRIVATE_ADDRESSES = 'true';
    await expect(NODES.webhook.execute(ctx('webhook', { url: 'http://nas.internal/hook', method: 'GET' }).c)).rejects.toThrow(/private network/);
    await expect(NODES.webhook.execute(ctx('webhook', { url: 'http://10.0.0.1/', method: 'GET' }).c)).rejects.toThrow(/private network/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses huge answers and redirects', async () => {
    mockFetch(new Response('x', { headers: { 'content-length': String(50 * 1024 * 1024) } }));
    await expect(NODES.webhook.execute(ctx('webhook', { url: 'https://x.io', method: 'GET' }).c)).rejects.toThrow(/too big/);
    mockFetch(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    await expect(NODES.webhook.execute(ctx('webhook', { url: 'https://x.io', method: 'GET' }).c)).rejects.toThrow(/redirect/);
  });
});

describe('Discord block', () => {
  const url = 'https://discord.com/api/webhooks/123/abc';

  it('posts the message template and passes it on', async () => {
    const fetch = mockFetch(json({ id: '1' }));
    const out = await NODES.discord.execute(ctx('discord', { url, body: 'Answer: {{input}}' }, { input: '42' }).c);
    expect(out).toBe('Answer: 42');
    const [u, init] = fetch.mock.calls[0];
    expect(u).toBe(`${url}?wait=true`);
    expect(JSON.parse(init!.body as string)).toMatchObject({ content: 'Answer: 42' });
  });

  it('splits long messages into parts under 2000 characters', async () => {
    const fetch = mockFetch(json({}), json({}), json({}));
    await NODES.discord.execute(ctx('discord', { url }, { input: 'word '.repeat(900) }).c);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) expect(JSON.parse(init!.body as string).content.length).toBeLessThanOrEqual(2000);
  });

  it('refuses a non-Discord URL and reports errors', async () => {
    await expect(NODES.discord.execute(ctx('discord', { url: 'https://evil.example/hook' }).c)).rejects.toThrow(/not a Discord webhook/);
    mockFetch(new Response('{"message": "Unknown Webhook"}', { status: 404 }));
    await expect(NODES.discord.execute(ctx('discord', { url }, { input: 'x' }).c)).rejects.toThrow(/Discord answered HTTP 404/);
  });

  it('never puts the webhook token in an error message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    const err = await NODES.discord.execute(ctx('discord', { url: 'https://discord.com/api/webhooks/123/SECRET-TOKEN' }, { input: 'x' }).c).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/discord\.com: ECONNRESET/);
    expect((err as Error).message).not.toContain('SECRET-TOKEN');
  });
});
