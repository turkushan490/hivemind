import type { NodeContext, NodeDefinition, NodeInput } from './index.js';

/**
 * Action blocks: they do something outside HiveMind (Home Assistant, any HTTP endpoint, Discord)
 * and pass a readable result on. Every failure throws with a clear message, which the engine
 * shows on the block and stores in the Problems log.
 */

const TIMEOUT_MS = 30_000;
const MAX_TEXT = 100_000;

/** What flows into the block: the last answer wired in, else the question. */
const inputText = (ctx: NodeContext) => {
  const prev = ctx.inputs.filter((i) => i.type !== 'input');
  return prev.length ? prev[prev.length - 1].text : ctx.question;
};

const labelled = (inputs: NodeInput[]) =>
  inputs
    .filter((i) => i.type !== 'input')
    .map((i) => `### ${i.label}\n${i.text}`)
    .join('\n\n');

/** A template that is JSON (starts with "[" or "{", but not "{{"). */
const isJson = (tpl: string) => /^\s*(\[|\{(?!\{))/.test(tpl);

type Escape = 'json' | 'url' | 'none';

/**
 * Fills {{input}}, {{question}}, {{inputs}} and {{vars.name}}. A JSON template gets the values JSON-escaped,
 * so `{"message": "{{input}}"}` stays valid whatever the text contains; a URL gets them URL-encoded.
 */
export function fillTemplate(tpl: string, ctx: Pick<NodeContext, 'question' | 'inputs'> & Partial<Pick<NodeContext, 'vars'>>, escape: Escape = isJson(tpl) ? 'json' : 'none'): string {
  const values: Record<string, string> = {
    input: inputText(ctx as NodeContext),
    question: ctx.question,
    inputs: labelled(ctx.inputs),
  };
  return tpl.replace(/\{\{\s*(input|question|inputs|vars\.([a-zA-Z0-9_]{1,40}))\s*\}\}/g, (_, k: string, name?: string) => {
    // {{vars.name}}: a value sent with the run; unknown ones are empty.
    const v = name !== undefined ? (ctx.vars?.[name] ?? '') : values[k];
    return escape === 'json' ? JSON.stringify(v).slice(1, -1) : escape === 'url' ? encodeURIComponent(v.trim()) : v;
  });
}

/** fetch with a timeout that also stops when the run is cancelled. */
async function send(url: string, init: RequestInit, signal: AbortSignal | undefined, what: string): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (timeout.aborted) throw new Error(`${what} did not answer within ${TIMEOUT_MS / 1000} s (${url})`);
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`Can't reach ${what} at ${url}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
  }
}

/** Throws with the status and the start of the body when the answer is not 2xx. */
async function ensureOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
  const hint = res.status === 401 || res.status === 403 ? ' — check the token' : res.status === 404 ? ' — check the address / name' : '';
  throw new Error(`${what} answered HTTP ${res.status}${hint}${body ? `: ${body}` : ''}`);
}

const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${what} is not valid JSON after filling in the template: ${(err as Error).message}`);
  }
};

interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

/** "light.kitchen (Kitchen): on — brightness 200, color_mode brightness" */
function describeState(s: HaState): string {
  const { friendly_name, ...attrs } = s.attributes ?? {};
  const extra = Object.entries(attrs)
    .filter(([, v]) => v !== null && (typeof v !== 'object' || Array.isArray(v)))
    .slice(0, 12)
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(',') : v}`)
    .join(', ');
  return `${s.entity_id}${friendly_name ? ` (${friendly_name})` : ''}: ${s.state}${extra ? ` — ${extra}` : ''}`;
}

export const ACTION_NODES: Record<'homeassistant' | 'webhook' | 'discord', NodeDefinition> = {
  homeassistant: {
    usesModel: false,
    async execute(ctx) {
      const ha = ctx.services.homeAssistant?.();
      if (!ha) throw new Error('Home Assistant is not connected: add its address and a long-lived token in Settings → Home Assistant');
      const headers = { authorization: `Bearer ${ha.token}`, 'content-type': 'application/json' };
      const c = ctx.node.config;

      if ((c.haOp ?? 'state') === 'state') {
        const ids = fillTemplate(c.entities ?? '', ctx, 'none')
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length === 0) throw new Error('Name one or more entities to read, e.g. sensor.living_room_temperature');
        ctx.progress(`Reading ${ids.length === 1 ? ids[0] : `${ids.length} entities`}…`);
        const lines: string[] = [];
        for (const id of ids) {
          if (!/^[a-z0-9_]+\.[a-z0-9_]+$/i.test(id)) throw new Error(`"${id}" is not an entity id (like light.kitchen)`);
          const res = await send(`${ha.url}/api/states/${id}`, { headers }, ctx.signal, 'Home Assistant');
          if (res.status === 404) throw new Error(`Home Assistant has no entity "${id}"`);
          await ensureOk(res, 'Home Assistant');
          lines.push(describeState((await res.json()) as HaState));
        }
        ctx.progress(ids.length === 1 ? lines[0].split(': ').slice(1).join(': ').slice(0, 60) : `Read ${ids.length} entities`);
        return lines.join('\n');
      }

      const service = fillTemplate(c.service ?? '', ctx, 'none').trim();
      const m = service.match(/^([a-z0-9_]+)\.([a-z0-9_]+)$/i);
      if (!m) throw new Error(`Name the service as domain.service, e.g. light.turn_on${service ? ` (got "${service}")` : ''}`);
      const data = c.body?.trim() ? parseJson(fillTemplate(c.body, ctx, 'json'), 'The service data') : {};
      ctx.progress(`Calling ${service}…`);
      const res = await send(`${ha.url}/api/services/${m[1]}/${m[2]}`, { method: 'POST', headers, body: JSON.stringify(data) }, ctx.signal, 'Home Assistant');
      if (res.status === 400) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`Home Assistant refused ${service}: ${body || 'bad service data'}`);
      }
      await ensureOk(res, 'Home Assistant');
      const changed = ((await res.json().catch(() => [])) as HaState[]) ?? [];
      ctx.progress(`Called ${service}${changed.length ? ` · ${changed.length} changed` : ''}`);
      return changed.length ? `Called ${service}. Changed:\n${changed.map(describeState).join('\n')}` : `Called ${service}.`;
    },
  },

  webhook: {
    usesModel: false,
    async execute(ctx) {
      const c = ctx.node.config;
      const url = fillTemplate(c.url ?? '', ctx, 'url').trim();
      if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(url ? `"${url}" is not an http(s) address` : 'Fill in the URL to call');
      const method = c.method ?? 'POST';
      const headers: Record<string, string> = {};
      for (const line of (c.headers ?? '').split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = fillTemplate(line.slice(i + 1), ctx, 'none').replace(/[\r\n]+/g, ' ').trim();
        else if (line.trim()) throw new Error(`Header line "${line.trim()}" needs the form Name: value`);
      }
      let body: string | undefined;
      if (method !== 'GET') {
        // No template: send what flows in, as JSON.
        const tpl = c.body ?? '{"text": "{{input}}", "question": "{{question}}"}';
        body = fillTemplate(tpl, ctx);
        if (isJson(tpl)) {
          parseJson(body, 'The body');
          headers['content-type'] ??= 'application/json';
        } else headers['content-type'] ??= 'text/plain; charset=utf-8';
      }
      ctx.progress(`${method} ${new URL(url).host}…`);
      const res = await send(url, { method, headers, body }, ctx.signal, new URL(url).host);
      await ensureOk(res, new URL(url).host);
      let text = await res.text();
      // Pretty JSON reads better for the next model.
      if ((res.headers.get('content-type') ?? '').includes('json')) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {}
      }
      ctx.progress(`HTTP ${res.status}${text ? ` · ${text.length.toLocaleString('en')} chars` : ''}`);
      return text.slice(0, MAX_TEXT) || `HTTP ${res.status} (empty answer)`;
    },
  },

  discord: {
    usesModel: false,
    async execute(ctx) {
      const c = ctx.node.config;
      const url = (c.url ?? '').trim();
      if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+$/i.test(url))
        throw new Error(url ? 'That is not a Discord webhook URL (https://discord.com/api/webhooks/…)' : 'Paste the Discord webhook URL (channel settings → Integrations → Webhooks)');
      const message = fillTemplate(c.body ?? '{{input}}', ctx, 'none').trim();
      if (!message) throw new Error('The message is empty');
      // Discord takes 2000 characters per message: longer answers go as several.
      const parts = message.match(/[\s\S]{1,1990}(?=\s|$)|[\s\S]{1,1990}/g) ?? [message];
      for (let i = 0; i < parts.length; i++) {
        ctx.progress(parts.length > 1 ? `Sending ${i + 1} of ${parts.length}…` : 'Sending to Discord…');
        const res = await send(
          `${url}${url.includes('?') ? '&' : '?'}wait=true`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: parts[i].trim(), allowed_mentions: { parse: [] } }) },
          ctx.signal,
          'Discord',
        );
        await ensureOk(res, 'Discord');
      }
      ctx.progress(`Sent to Discord${parts.length > 1 ? ` (${parts.length} messages)` : ''}`);
      return message;
    },
  },
};
