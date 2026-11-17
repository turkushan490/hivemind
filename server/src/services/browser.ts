// H19: the Browser block — headless Chromium (Playwright) inside the container. Steps like "goto", "click", "type",
// "screenshot", "text", "console", "links"; a test mode that opens every page of a project, clicks what can be
// clicked and reports console errors and broken links. It never presses pay / order / buy buttons unless the run
// passed a Pause the owner approved.
import { existsSync } from 'node:fs';

export interface BrowserStepResult {
  text: string;
  screenshots: { name: string; data: Buffer }[];
}

/** Buttons that spend money or send something off: only after the owner approved a Pause in this run. */
export const RISKY = /\b(pay|payment|order|buy|purchase|checkout|check out|place order|confirm|bestel|betaal|afrekenen|koop|submit order)\b/i;

/** The Chromium Playwright installed in the image (PLAYWRIGHT_BROWSERS_PATH), or a local Chrome/Edge. */
function chromiumPath(): string | undefined {
  const candidates = [
    process.env.BROWSER_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p));
}

export async function browserAvailable(): Promise<boolean> {
  try {
    const pw = await import('playwright-core');
    return existsSync(pw.chromium.executablePath()) || !!chromiumPath();
  } catch {
    return false;
  }
}

export interface Step {
  op: string;
  arg: string;
}

/** One step per line: "goto https://…", "click Shop", "type #name Jarvis", "wait 500", "screenshot home", "text". */
export function parseSteps(text: string): Step[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = /^(\w+)\s*(.*)$/.exec(l)!;
      return { op: m[1].toLowerCase(), arg: m[2].trim() };
    });
}

/**
 * Runs the steps in one fresh browser. base = where relative URLs ("/api/projects/preview/…") go (HiveMind itself).
 * allowRisky: a Pause before this block was approved. internet: may open sites outside HiveMind and this machine.
 */
export async function runBrowser(
  steps: Step[],
  o: { base: string; allowRisky?: boolean; internet?: boolean; timeoutMs?: number; signal?: AbortSignal; onStep?: (note: string) => void },
): Promise<BrowserStepResult> {
  const pw = await import('playwright-core').catch(() => {
    throw new Error('The browser is not installed in this HiveMind image');
  });
  const exe = existsSync(pw.chromium.executablePath()) ? undefined : chromiumPath();
  const browser = await pw.chromium.launch({ headless: true, ...(exe && { executablePath: exe }), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const out: string[] = [];
  const screenshots: { name: string; data: Buffer }[] = [];
  const consoleLines: string[] = [];
  const deadline = Date.now() + (o.timeoutMs ?? 120_000);
  const abort = () => void browser.close().catch(() => {});
  o.signal?.addEventListener('abort', abort, { once: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 400));
    });
    page.on('pageerror', (e) => consoleLines.push(`error: ${e.message}`.slice(0, 400)));
    const url = (u: string) => {
      const full = /^https?:\/\//i.test(u) ? u : new URL(u.startsWith('/') ? u : `/${u}`, o.base).toString();
      if (!o.internet && !full.startsWith(o.base) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(full)) throw new Error(`This workflow may not open sites on the internet (${full.slice(0, 80)}): allow it on the block`);
      return full;
    };
    for (const s of steps) {
      if (Date.now() > deadline) throw new Error('The browser took too long');
      if (o.signal?.aborted) throw new Error('Cancelled');
      o.onStep?.(`${s.op} ${s.arg}`.trim().slice(0, 100));
      switch (s.op) {
        case 'goto':
        case 'open': {
          const res = await page.goto(url(s.arg), { waitUntil: 'load' });
          out.push(`Opened ${page.url().replace(o.base, '/')} (HTTP ${res?.status() ?? '?'}, "${(await page.title()).slice(0, 80)}")`);
          break;
        }
        case 'click': {
          const target = await locate(page, s.arg);
          const label = ((await target.innerText().catch(() => '')) || s.arg).trim().slice(0, 80);
          if (RISKY.test(label) && !o.allowRisky) throw new Error(`Not clicking "${label}": that could pay or order something. Put a Pause before this block and approve it first.`);
          await target.click();
          await page.waitForLoadState('load').catch(() => {});
          out.push(`Clicked "${label}"`);
          break;
        }
        case 'type':
        case 'fill': {
          const m = /^(\S+)\s+([\s\S]*)$/.exec(s.arg);
          if (!m) throw new Error(`type needs a field and text: "type #email me@example.com"`);
          await (await locate(page, m[1])).fill(m[2]);
          out.push(`Typed into ${m[1]}`);
          break;
        }
        case 'press':
          await page.keyboard.press(s.arg || 'Enter');
          out.push(`Pressed ${s.arg || 'Enter'}`);
          break;
        case 'wait':
          if (/^\d+$/.test(s.arg)) await page.waitForTimeout(Math.min(30_000, Number(s.arg)));
          else await (await locate(page, s.arg)).waitFor();
          break;
        case 'screenshot':
          screenshots.push({ name: s.arg || `page-${screenshots.length + 1}`, data: await page.screenshot({ fullPage: false }) });
          out.push(`Screenshot ${s.arg || screenshots.length}`);
          break;
        case 'text':
          out.push(`Text of ${page.url().replace(o.base, '/')}:\n${(await page.innerText('body').catch(() => '')).replace(/\n{3,}/g, '\n\n').slice(0, 6000)}`);
          break;
        case 'console':
          out.push(consoleLines.length ? `Console:\n${consoleLines.join('\n')}` : 'Console: no errors');
          break;
        case 'links':
          out.push(await checkLinks(page, o.base));
          break;
        case 'test':
          out.push(await testSite(page, o.base, url(s.arg || '/'), consoleLines, screenshots, o.onStep));
          break;
        default:
          throw new Error(`Unknown browser step "${s.op}" (goto, click, type, press, wait, screenshot, text, console, links, test)`);
      }
    }
    return { text: out.join('\n'), screenshots };
  } finally {
    o.signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
  }
}

type Page = import('playwright-core').Page;

/** A CSS selector when it looks like one (#id, .class, [attr], tag>…), else visible text (button, link, label). */
async function locate(page: Page, what: string) {
  if (/^[#.[]|^[a-z]+[#.[>:]|^(input|button|a|select|textarea)$/i.test(what)) return page.locator(what).first();
  const role = page.getByRole('button', { name: what }).or(page.getByRole('link', { name: what }));
  if (await role.count()) return role.first();
  return page.getByText(what, { exact: false }).first();
}

/** Every link on the page with whether it opens (HTTP < 400). */
async function checkLinks(page: Page, base: string): Promise<string> {
  const hrefs = [...new Set(await page.$$eval('a[href]', (as) => as.map((a) => (a as unknown as { href: string }).href)))].filter((h) => /^https?:/i.test(h)).slice(0, 60);
  const lines: string[] = [];
  for (const h of hrefs) {
    const r = await page.request.get(h, { timeout: 10_000 }).catch(() => undefined);
    lines.push(`${r && r.status() < 400 ? 'ok    ' : 'BROKEN'} ${h.replace(base, '/')}${r ? ` (${r.status()})` : ' (no answer)'}`);
  }
  return hrefs.length ? `Links:\n${lines.join('\n')}` : 'Links: none on this page';
}

/**
 * Test mode: every page of the site reachable by links (same site, at most 15), one screenshot each, every button
 * clicked once (not risky ones), console errors and broken links collected → a report.
 */
async function testSite(page: Page, base: string, start: string, consoleLines: string[], shots: { name: string; data: Buffer }[], onStep?: (n: string) => void): Promise<string> {
  const origin = new URL(start);
  const prefix = start.replace(/[^/]*$/, '');
  const queue = [start];
  const seen = new Set<string>();
  const report: string[] = [];
  const broken: string[] = [];
  while (queue.length && seen.size < 15) {
    const u = queue.shift()!.split('#')[0];
    if (seen.has(u)) continue;
    seen.add(u);
    onStep?.(`test ${u.replace(base, '/')}`);
    const before = consoleLines.length;
    const res = await page.goto(u, { waitUntil: 'load' }).catch((e: Error) => {
      broken.push(`${u.replace(base, '/')} (${e.message.slice(0, 80)})`);
      return undefined;
    });
    if (!res) continue;
    if (res.status() >= 400) {
      broken.push(`${u.replace(base, '/')} (HTTP ${res.status()})`);
      continue;
    }
    shots.push({ name: `test-${seen.size}`, data: await page.screenshot() });
    const links = await page.$$eval('a[href]', (as) => as.map((a) => (a as unknown as { href: string }).href)).catch(() => [] as string[]);
    for (const l of links) {
      const clean = l.split('#')[0];
      if (clean.startsWith(prefix) && new URL(clean).origin === origin.origin && !seen.has(clean)) queue.push(clean);
      else if (/^https?:/i.test(clean) && !clean.startsWith(prefix)) {
        /* outside links are not followed */
      }
    }
    // Every button once: does it do something without an error?
    const buttons = await page.getByRole('button').all().catch(() => []);
    const dead: string[] = [];
    for (const b of buttons.slice(0, 20)) {
      const name = ((await b.innerText().catch(() => '')) || '').trim().slice(0, 40);
      if (!name || RISKY.test(name) || !(await b.isVisible().catch(() => false))) continue;
      const html = await page.content();
      const errs = consoleLines.length;
      await b.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
      if (page.url().split('#')[0] !== u) {
        await page.goto(u, { waitUntil: 'load' }).catch(() => {});
      } else if ((await page.content()) === html && consoleLines.length === errs) dead.push(name);
    }
    const errors = consoleLines.slice(before);
    report.push(
      `Page ${u.replace(base, '/')}: "${(await page.title().catch(() => '')).slice(0, 60)}"${errors.length ? `\n  console: ${errors.slice(0, 5).join(' | ')}` : ''}${dead.length ? `\n  buttons that seem to do nothing: ${dead.join(', ')}` : ''}`,
    );
  }
  // Links that point at files in the site that don't exist.
  for (const u of [...seen]) {
    const r = await page.request.get(u).catch(() => undefined);
    if (r && r.status() >= 400 && !broken.some((b) => b.startsWith(u.replace(base, '/')))) broken.push(`${u.replace(base, '/')} (HTTP ${r.status()})`);
  }
  return [`Test of ${report.length} page${report.length === 1 ? '' : 's'}:`, ...report, broken.length ? `Broken links: ${broken.join(', ')}` : 'Broken links: none'].join('\n');
}
