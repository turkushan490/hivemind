import type { CanvasGraph, FileChange, Project, ProjectFile, RunEvent } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, chain, edge, node, runAndWait, testApp } from './helpers.js';

/** Projects: folders that stay, their blocks (Read project, Write files, Update notes, For each … Collect) and the preview. */

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
let projects: typeof import('../src/services/projects.js');

/** A fake Ollama: each chat is answered by reply(the last user message, the system prompt). */
let reply: (user: string, system: string) => string = () => 'ok';
const chats: { user: string; system: string }[] = [];
function fakeOllama() {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [] }));
    if (u.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: { role: string; content: string }[] };
      const user = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
      chats.push({ user, system });
      return new Response(`${JSON.stringify({ message: { content: reply(user, system) } })}\n${JSON.stringify({ done: true, done_reason: 'stop' })}\n`);
    }
    return new Response('not found', { status: 404 });
  });
}

const M = { providerId: 'ollama', model: 'coder' };
const api = (who: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: bearer(who), ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });

async function newProject(who: string, name: string): Promise<Project> {
  const res = await api(who, 'POST', '/api/projects', { name });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Project;
}
const put = (who: string, id: string, path: string, text: string) => api(who, 'PUT', `/api/projects/${id}/file?path=${encodeURIComponent(path)}`, { text });
const read = async (who: string, id: string, path: string) => (await api(who, 'GET', `/api/projects/${id}/file?path=${encodeURIComponent(path)}`)).json() as { text: string };
const tree = async (who: string, id: string) => ((await api(who, 'GET', `/api/projects/${id}/tree`)).json() as { files: ProjectFile[] }).files.map((f) => f.path);

beforeAll(async () => {
  ({ app, db } = await testApp('projects', [
    ['admin', 'admin'],
    ['a', 'user'],
    ['b', 'user'],
  ]));
  projects = await import('../src/services/projects.js');
  db.prepare("UPDATE users SET profile_id = 'everything'").run();
  db.prepare("INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1)").run();
});
beforeEach(() => {
  fakeOllama();
  chats.length = 0;
  reply = () => 'ok';
});
afterAll(() => app?.close());

describe('projects', () => {
  it('writes and reads a nested file, and refuses paths outside the project', async () => {
    const p = await newProject('a', 'Site');
    expect((await put('a', p.id, 'pages/blog/first.html', '<h1>Hi</h1>')).json()).toMatchObject({ path: 'pages/blog/first.html', status: 'added', added: 1 });
    expect((await read('a', p.id, 'pages/blog/first.html')).text).toBe('<h1>Hi</h1>');
    expect(await tree('a', p.id)).toEqual(['pages/blog/first.html']);
    for (const bad of ['../x.html', '/etc/passwd', 'C:/x.html', 'a/../../x', '.git/config', 'pages//x', './']) {
      expect((await put('a', p.id, bad, 'x')).statusCode, bad).toBe(400);
    }
    expect((await api('a', 'GET', `/api/projects/${p.id}/file?path=${encodeURIComponent('../../hivemind.db')}`)).statusCode).toBe(400);
    // A second write shows the diff.
    const change = (await put('a', p.id, 'pages/blog/first.html', '<h1>Hello</h1>\n<p>New</p>')).json() as FileChange;
    expect(change).toMatchObject({ status: 'changed', added: 2, removed: 1 });
    expect(change.diff).toContain('+ <p>New</p>');
  });

  it.skipIf(process.platform === 'win32')('refuses links that lead out of the project', async () => {
    const p = await newProject('a', 'Links');
    const root = projects.rootOf(p);
    symlinkSync('/etc', join(root, 'etc'));
    expect((await api('a', 'GET', `/api/projects/${p.id}/file?path=etc/hostname`)).statusCode).toBe(400);
    expect((await put('a', p.id, 'etc/evil.txt', 'x')).statusCode).toBe(400);
    expect(await tree('a', p.id)).toEqual([]);
  });

  it("B can't see or change A's project; an admin can", async () => {
    const p = await newProject('a', 'Private');
    await put('a', p.id, 'index.html', 'a');
    expect(((await api('b', 'GET', '/api/projects')).json() as Project[]).map((x) => x.id)).not.toContain(p.id);
    expect((await api('b', 'GET', `/api/projects/${p.id}/tree`)).statusCode).toBe(404);
    expect((await put('b', p.id, 'index.html', 'b')).statusCode).toBe(404);
    expect((await api('b', 'DELETE', `/api/projects/${p.id}`)).statusCode).toBe(404);
    expect((await api('admin', 'GET', `/api/projects/${p.id}/tree`)).statusCode).toBe(200);
    expect(((await api('admin', 'GET', '/api/projects')).json() as Project[]).find((x) => x.id === p.id)?.owner).toBe('user_a');
    // Not through the Files tab either.
    const up = await app.inject({ method: 'POST', url: `/api/files?name=${encodeURIComponent(`projects/${p.id}/x.html`)}`, headers: { ...bearer('b'), 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(up.statusCode).toBe(400);
    expect(((await api('admin', 'GET', '/api/files')).json() as { path: string }[]).some((f) => f.path.startsWith('projects/'))).toBe(false);
  });

  it('keeps to the size limits', async () => {
    const p = await newProject('a', 'Big');
    const old = { ...projects.PROJECT_LIMITS };
    Object.assign(projects.PROJECT_LIMITS, { totalBytes: 1000, files: 3 });
    try {
      expect((await put('a', p.id, 'a.txt', 'x'.repeat(600))).statusCode).toBe(200);
      expect((await put('a', p.id, 'b.txt', 'x'.repeat(600))).statusCode).toBe(413);
      await put('a', p.id, 'b.txt', 'x');
      await put('a', p.id, 'c.txt', 'x');
      expect((await put('a', p.id, 'd.txt', 'x')).statusCode).toBe(413);
    } finally {
      Object.assign(projects.PROJECT_LIMITS, old);
    }
    expect(() => projects.writeProjectFile(p, 'big.js', 'x'.repeat(2 * 1024 * 1024 + 1), { byBlock: true })).toThrow(/too big/);
    expect(() => projects.writeProjectFile(p, 'run.sh', 'echo', { byBlock: true })).toThrow(/may not write .sh/);
  });

  it('serves the preview on a signed link, sandboxed, without a login', async () => {
    const p = await newProject('a', 'Preview');
    await put('a', p.id, 'index.html', '<link rel="stylesheet" href="css/site.css"><h1>Home</h1>');
    await put('a', p.id, 'css/site.css', 'h1{color:red}');
    const { previewUrl } = (await api('a', 'GET', `/api/projects/${p.id}/tree`)).json() as { previewUrl: string };
    const page = await app.inject({ method: 'GET', url: previewUrl });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toMatch(/^sandbox allow-scripts/);
    expect(page.headers['content-security-policy']).not.toContain('allow-same-origin');
    expect(page.body).toContain('<h1>Home</h1>');
    expect((await app.inject({ method: 'GET', url: `${previewUrl}css/site.css` })).body).toBe('h1{color:red}');
    expect((await app.inject({ method: 'GET', url: `${previewUrl}../../hivemind.db` })).statusCode).not.toBe(200);
    expect((await app.inject({ method: 'GET', url: `${previewUrl}..%2F..%2F..%2Fhivemind.db` })).statusCode).toBe(404);
    const forged = previewUrl.replace(/\.[^./]+\/$/, '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/');
    expect((await app.inject({ method: 'GET', url: forged })).statusCode).toBe(404);
  });
});

describe('project blocks', () => {
  const site = async (name: string) => (await newProject('a', name)).id;

  it('Write files: fenced blocks with a path and JSON make folders and files; delete works; blocked types are refused', async () => {
    const id = await site('Blocks');
    reply = () =>
      'Here you go.\n\n```html path=index.html\n<h1>Home</h1>\n```\n\n```css path=css/site.css\nbody { margin: 0 }\n```\n\n```markdown path=docs/notes.md\nUse ```code``` here\n```\n\n```sh path=deploy.sh\nrm -rf /\n```';
    const graph = chain(node('q', 'input'), node('c', 'llm', { model: M }), node('w', 'writeFiles', { project: id }), node('o', 'output'));
    const run = await runAndWait(app, { question: 'Make a site', graph }, 'a');
    expect(run.status).toBe('done');
    expect((await tree('a', id)).sort()).toEqual(['css/site.css', 'docs/notes.md', 'index.html']);
    expect((await read('a', id, 'docs/notes.md')).text).toBe('Use ```code``` here\n');
    expect(run.final).toContain('Refused');
    expect(run.final).toContain('deploy.sh');

    reply = () => JSON.stringify({ files: [{ path: 'pages/about.html', content: '<h1>About</h1>' }], delete: ['css/site.css'] });
    const run2 = await runAndWait(app, { question: 'About page', graph }, 'a');
    expect(run2.status).toBe('done');
    expect((await tree('a', id)).sort()).toEqual(['docs/notes.md', 'index.html', 'pages/about.html']);
    const history = (await api('a', 'GET', `/api/projects/${id}/history`)).json() as { changes: { runId?: string; changes: FileChange[] }[] };
    expect(history.changes[0].runId).toBe(run2.id);
    expect(history.changes[0].changes.map((c) => `${c.status} ${c.path}`).sort()).toEqual(['added pages/about.html', 'deleted css/site.css']);
  });

  it('Read project: keeps to the budget, always includes PROJECT.md, and lists what did not fit', async () => {
    const id = await site('Reader');
    await put('a', id, 'PROJECT.md', '# Reader\nBlue and calm.');
    await put('a', id, 'a.html', 'A'.repeat(600));
    await put('a', id, 'b.html', 'B'.repeat(600));
    await put('a', id, 'node_modules/x/index.js', 'skip me');
    const graph = chain(node('q', 'input'), node('r', 'readProject', { budget: 1000, globs: '*.html, *.js' }), node('o', 'output'));
    const run = await runAndWait(app, { question: 'x', graph, vars: { project: 'Reader' } }, 'a');
    expect(run.final).toContain('Blue and calm.');
    expect(run.final).toContain('### a.html');
    expect(run.final).not.toContain('### b.html');
    expect(run.final).toMatch(/Not included[\s\S]*b\.html/);
    expect(run.final).not.toContain('skip me');

    // Only the files a plan names.
    const named = chain(node('q', 'input'), node('t', 'template', { prompt: '{"files":[{"path":"b.html"}]}' }), node('r', 'readProject', { project: id, onlyNamed: true }), node('o', 'output'));
    const run2 = await runAndWait(app, { question: 'x', graph: named }, 'a');
    expect(run2.final).toContain('### b.html');
    expect(run2.final).not.toContain('### a.html');
  });

  it("can't read or write another user's project", async () => {
    const id = await site('Mine');
    const graph = chain(node('q', 'input'), node('r', 'readProject', { project: id }), node('o', 'output'));
    const run = await runAndWait(app, { question: 'x', graph }, 'b');
    expect(run.events.find((e) => e.type === 'error' && e.nodeId === 'r')?.error).toMatch(/not found/);
  });

  it('For each runs the blocks up to Collect once per item, in order', async () => {
    const id = await site('Loop');
    reply = (user) => {
      const path = user.match(/"path":"([^"]+)"/)?.[1] ?? 'x';
      return `\`\`\`html path=${path}\n<p>${path}</p>\n\`\`\``;
    };
    const graph: CanvasGraph = {
      nodes: [
        node('q', 'input'),
        node('plan', 'template', { prompt: '{"files":[{"path":"one.html"},{"path":"two.html"},{"path":"three.html"}]}' }),
        node('each', 'foreach'),
        node('c', 'llm', { model: M, prompt: 'Write {{inputs}}' }),
        node('w', 'writeFiles', { project: id }),
        node('all', 'collect'),
        node('o', 'output'),
      ],
      edges: [edge('q', 'plan'), edge('plan', 'each'), edge('each', 'c'), edge('c', 'w'), edge('w', 'all'), edge('all', 'o')],
    };
    const run = await runAndWait(app, { question: 'x', graph }, 'a');
    expect(run.status).toBe('done');
    expect((await tree('a', id)).sort()).toEqual(['one.html', 'three.html', 'two.html']);
    expect(chats.map((c) => c.user.match(/"path":"([^"]+)"/)?.[1])).toEqual(['one.html', 'two.html', 'three.html']);
    expect(run.final).toMatch(/Item 1: one\.html[\s\S]*Item 2: two\.html[\s\S]*Item 3: three\.html/);
  });

  it('refuses a For each without one Collect, and blocks that leave the loop', async () => {
    const noCollect = chain(node('q', 'input'), node('each', 'foreach'), node('t', 'template'), node('o', 'output'));
    expect((await api('a', 'POST', '/api/runs', { question: 'x', graph: noCollect })).statusCode).toBe(400);
    const leaks: CanvasGraph = {
      nodes: [node('q', 'input'), node('each', 'foreach'), node('t', 'template'), node('all', 'collect'), node('o', 'output')],
      edges: [edge('q', 'each'), edge('each', 't'), edge('t', 'all'), edge('t', 'o'), edge('all', 'o')],
    };
    const res = await api('a', 'POST', '/api/runs', { question: 'x', graph: leaks });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/inside/);
  });

  it('Site builder: a second run sees the files and PROJECT.md of the first, and changes only the planned files', async () => {
    const id = await site('Builder');
    const { TEMPLATES } = await import('../../web/src/canvas/templates.js');
    const t = TEMPLATES.find((x) => x.id === 'site-builder')!;
    const graph = t.build({ text: [M, M, M], judge: M, image: [], decision: [] } as never);
    // Pause blocks (the template's checks) are taken out here: Pause has its own tests.
    const pauses = graph.nodes.filter((n) => n.type === 'pause').map((n) => n.id);
    for (const pid of pauses) {
      const into = graph.edges.filter((e) => e.target === pid).map((e) => e.source);
      const out = graph.edges.filter((e) => e.source === pid).map((e) => e.target);
      graph.edges = graph.edges.filter((e) => e.source !== pid && e.target !== pid);
      for (const a of into) for (const b of out) graph.edges.push(edge(a, b));
    }
    graph.nodes = graph.nodes.filter((n) => !pauses.includes(n.id));
    reply = (user, system) => {
      if (/PROJECT\.md, the notes/.test(system)) return `# Builder\n## Decisions\n- ${/blog/.test(user) ? 'Added a blog. ' : ''}Started.`;
      if (/plan/i.test(system)) return /blog/.test(user) ? '{"files":[{"path":"blog.html","action":"create","reason":"blog"}]}' : '{"files":[{"path":"index.html","action":"create","reason":"home"}]}';
      if (/review/i.test(system)) return 'All good.';
      if (/web designer/i.test(system)) return 'Looks good.';
      const path = user.match(/"path":"([^"]+)"/)?.[1] ?? 'index.html';
      return `\`\`\`html path=${path}\n<h1>${path}</h1>\n\`\`\``;
    };
    const one = await runAndWait(app, { question: 'Make a home page', graph, vars: { project: id } }, 'a');
    expect(one.status, JSON.stringify(one.events.filter((e: RunEvent) => e.type === 'error'))).toBe('done');
    expect((await tree('a', id)).sort()).toEqual(['PROJECT.md', 'index.html']);
    const before = (await read('a', id, 'index.html')).text;
    chats.length = 0;
    const two = await runAndWait(app, { question: 'Add a blog', graph, vars: { project: id } }, 'a');
    expect(two.status).toBe('done');
    // The planner of run two read run one's files and notes.
    const planner = chats.find((c) => /plan/i.test(c.system))!;
    expect(planner.user).toContain('### index.html');
    expect(planner.user).toContain('Started.');
    expect((await tree('a', id)).sort()).toEqual(['PROJECT.md', 'blog.html', 'index.html']);
    expect((await read('a', id, 'index.html')).text).toBe(before);
    expect((await read('a', id, 'PROJECT.md')).text).toContain('Added a blog');
  });
});

describe('project folders on disk', () => {
  it('keeps .git out of the tree and the zip', async () => {
    const p = await newProject('a', 'Zip');
    await put('a', p.id, 'index.html', 'x');
    mkdirSync(join(projects.rootOf(p), '.git'), { recursive: true });
    writeFileSync(join(projects.rootOf(p), '.git', 'config'), 'secret');
    expect(await tree('a', p.id)).toEqual(['index.html']);
    const zip = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/zip`, headers: bearer('a') });
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.toString('latin1')).not.toContain('.git/config');
  });
});
