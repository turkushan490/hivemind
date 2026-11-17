import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserAvailable, parseSteps, RISKY, runBrowser } from '../src/services/browser.js';

const PAGES: Record<string, string> = {
  '/index.html': `<html><head><title>Home</title></head><body><h1>Clicker</h1>
    <a href="/about.html">About</a> <a href="/missing.html">Gone</a>
    <button id="add" onclick="document.getElementById('n').textContent='1'">Add</button>
    <button>Nothing</button>
    <button onclick="document.body.dataset.ordered='yes'">Place order</button>
    <span id="n">0</span><input id="name">
    <script>window.boom()</script></body></html>`,
  '/about.html': '<html><head><title>About</title></head><body>About us <a href="/index.html">Home</a></body></html>',
};

let server: Server;
let base = '';
let ok = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const page = PAGES[req.url ?? ''];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
    res.end(page ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  ok = await browserAvailable();
});
afterAll(() => server.close());

describe('Browser block (H19)', () => {
  it('reads steps from a numbered list and knows the risky buttons', () => {
    expect(parseSteps('1. goto /index.html\n2) click Add\n# a note\n- type #name Jarvis')).toEqual([
      { op: 'goto', arg: '/index.html' },
      { op: 'click', arg: 'Add' },
      { op: 'type', arg: '#name Jarvis' },
    ]);
    expect(RISKY.test('Place order')).toBe(true);
    expect(RISKY.test('Add to list')).toBe(false);
  });

  it('opens, clicks, types, reads the text, the console and the links, and takes a screenshot', async (t) => {
    if (!ok) return t.skip();
    const r = await runBrowser(parseSteps('goto /index.html\nclick Add\ntype #name Jarvis\ntext\nconsole\nlinks\nscreenshot home'), { base });
    expect(r.text).toContain('Opened /index.html (HTTP 200, "Home")');
    expect(r.text).toContain('Clicked "Add"');
    expect(r.text).toMatch(/Text of[\s\S]*Clicker/);
    expect(r.text).toMatch(/Console:[\s\S]*boom/);
    expect(r.text).toMatch(/ok\s+\/about\.html/);
    expect(r.text).toMatch(/BROKEN \/missing\.html \(404\)/);
    expect(r.screenshots).toHaveLength(1);
    expect(r.screenshots[0].data.length).toBeGreaterThan(1000);
  }, 60_000);

  it('refuses "Place order" without an approved Pause, and the internet unless allowed', async (t) => {
    if (!ok) return t.skip();
    await expect(runBrowser(parseSteps('goto /index.html\nclick Place order'), { base })).rejects.toThrow(/Pause/);
    await expect(runBrowser(parseSteps('goto https://example.com/'), { base })).rejects.toThrow(/internet/);
    const r = await runBrowser(parseSteps('goto /index.html\nclick Place order'), { base, allowRisky: true });
    expect(r.text).toContain('Clicked "Place order"');
  }, 60_000);

  it('test mode visits every page and reports console errors, dead buttons and broken links', async (t) => {
    if (!ok) return t.skip();
    const r = await runBrowser([{ op: 'test', arg: '/index.html' }], { base });
    expect(r.text).toContain('Test of 2 pages');
    expect(r.text).toMatch(/console: .*boom/);
    expect(r.text).toMatch(/buttons that seem to do nothing: .*Nothing/);
    expect(r.text).toMatch(/Broken links: .*missing\.html/);
    expect(r.screenshots.length).toBe(2);
  }, 90_000);
});
