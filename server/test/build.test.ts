import type { BuildResult, Project } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, chain, node, runAndWait, testApp } from './helpers.js';

/**
 * Builds run npm inside the container: on a copy of the project, with nothing of HiveMind's environment, and a
 * time limit. The test project needs no packages, so it builds without the internet.
 */

let app: FastifyInstance;
let build: typeof import('../src/services/build.js');
let projects: typeof import('../src/services/projects.js');

const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: bearer('u1'), ...(payload !== undefined && { payload: payload as Record<string, unknown> }) });
const put = (id: string, path: string, text: string) => api('PUT', `/api/projects/${id}/file?path=${encodeURIComponent(path)}`, { text });

const BUILD_JS = `
const fs = require('fs');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', '<h1>Built</h1>');
fs.writeFileSync('dist/env.txt', JSON.stringify({ secret: process.env.HM_TEST_SECRET ?? null, key: process.env.SECRET_KEY ?? null, data: process.env.DATA_DIR ?? null }));
console.log('built ok');
`;

beforeAll(async () => {
  // Secrets HiveMind has in its environment: the build must not see them.
  process.env.HM_TEST_SECRET = 'do-not-leak';
  ({ app } = await testApp('build'));
  build = await import('../src/services/build.js');
  projects = await import('../src/services/projects.js');
});
afterAll(() => {
  delete process.env.HM_TEST_SECRET;
  return app?.close();
});

describe('project builds', () => {
  it('npm is in this environment', () => {
    expect(build.npmAvailable()).toBe(true);
  });

  it('builds on a copy, copies the output back, and keeps HiveMind secrets out', async () => {
    const p = (await api('POST', '/api/projects', { name: 'Vite-like' })).json() as Project;
    await put(p.id, 'package.json', JSON.stringify({ name: 'site', version: '1.0.0', private: true, scripts: { build: 'node build.js' } }));
    await put(p.id, 'build.js', BUILD_JS);
    const res = await api('POST', `/api/projects/${p.id}/build`, {});
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json() as BuildResult;
    expect(r.ok, r.log).toBe(true);
    expect(r.outDir).toBe('dist');
    expect(r.log).toContain('built ok');
    expect((await api('GET', `/api/projects/${p.id}/file?path=dist/index.html`)).json()).toMatchObject({ text: '<h1>Built</h1>' });
    const env = JSON.parse(((await api('GET', `/api/projects/${p.id}/file?path=dist/env.txt`)).json() as { text: string }).text);
    expect(env).toEqual({ secret: null, key: null, data: null });
    // node_modules and the lock file stay in the build folder, not in the project.
    const tree = projects.projectTree(p).map((f) => f.path);
    expect(tree.some((f) => f.startsWith('node_modules/'))).toBe(false);
  }, 120_000);

  it('the time limit stops a hanging script', async () => {
    const p = (await api('POST', '/api/projects', { name: 'Hangs' })).json() as Project;
    await put(p.id, 'package.json', JSON.stringify({ name: 'hang', version: '1.0.0', private: true, scripts: { build: 'node -e "setInterval(() => {}, 1000)"' } }));
    const t0 = Date.now();
    const r = await build.buildProject(p, { timeoutMs: 8000 });
    expect(r.ok).toBe(false);
    expect(r.log).toMatch(/stopped after 8 seconds/);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 60_000);

  it('the Build block fails with the log when the build fails, and needs a package.json', async () => {
    const p = (await api('POST', '/api/projects', { name: 'Broken' })).json() as Project;
    const graph = chain(node('q', 'input'), node('b', 'build', { project: p.id }), node('o', 'output'));
    const none = await runAndWait(app, { question: 'x', graph });
    expect(none.events.find((e) => e.type === 'error' && e.nodeId === 'b')?.error).toMatch(/no package\.json/);
    await put(p.id, 'package.json', JSON.stringify({ name: 'b', version: '1.0.0', private: true, scripts: { build: 'node -e "console.error(\'boom\'); process.exit(3)"' } }));
    const run = await runAndWait(app, { question: 'x', graph });
    const error = run.events.find((e) => e.type === 'error' && e.nodeId === 'b')?.error ?? '';
    expect(error).toMatch(/Build failed/);
    expect(error).toContain('boom');
  }, 120_000);
});

describe('Build block options for workflows that fix their own build', () => {
  it('a failed build passes its log on, and a project without package.json passes', async () => {
    const p = (await api('POST', '/api/projects', { name: 'Fix me' })).json() as Project;
    const graph = chain(node('q', 'input'), node('b', 'build', { project: p.id, buildFailOk: true, buildOptional: true }), node('o', 'output'));
    const none = await runAndWait(app, { question: 'x', graph });
    expect(none.final).toMatch(/^BUILD SKIPPED/);
    await put(p.id, 'package.json', JSON.stringify({ name: 'f', version: '1.0.0', private: true, scripts: { build: 'node -e "console.error(\'Cannot find module x\'); process.exit(1)"' } }));
    const failed = await runAndWait(app, { question: 'x', graph });
    expect(failed.status).toBe('done');
    expect(failed.final).toMatch(/^BUILD FAILED/);
    expect(failed.final).toContain('Cannot find module x');
  }, 120_000);
});
