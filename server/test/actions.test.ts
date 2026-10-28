import type { CanvasNode, NodeConfig, NodeType } from '@hivemind/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fillTemplate } from '../src/nodes/actions.js';
import { NODES, type NodeContext, type NodeServices } from '../src/nodes/index.js';

afterEach(() => vi.unstubAllGlobals());

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
});
