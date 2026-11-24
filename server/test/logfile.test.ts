import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, testApp } from './helpers.js';

/** Settings → Log file: off / on / debug, tail, download, clear; secrets and hidden paths never in the file. */

let app: FastifyInstance;
let log: typeof import('../src/logfile.js');

beforeAll(async () => {
  delete process.env.LOG_FILE;
  ({ app } = await testApp('logfile', [
    ['u1', 'admin'],
    ['u2', 'user'],
  ]));
  log = await import('../src/logfile.js');
});
afterAll(() => app.close());

const get = (url: string, who = 'u1') => app.inject({ method: 'GET', url, headers: bearer(who) });
const setMode = (mode: string, who = 'u1') => app.inject({ method: 'PUT', url: '/api/settings/log', headers: bearer(who), payload: { mode } });

describe('log file', () => {
  it('is off by default in Docker and writes nothing', async () => {
    const s = (await get('/api/settings/log')).json() as { mode: string; path: string };
    expect(s.mode).toBe('off');
    log.appendLog('server', 'should not be written');
    expect(existsSync(s.path)).toBe(false);
  });

  it('only admins can see or change it', async () => {
    expect((await get('/api/settings/log', 'u2')).statusCode).toBe(403);
    expect((await setMode('debug', 'u2')).statusCode).toBe(403);
    expect((await get('/api/logs/download', 'u2')).statusCode).toBe(403);
    expect((await setMode('loud')).statusCode).toBe(400);
  });

  it('on: problems and warnings, no request lines; debug: requests and debug lines too', async () => {
    expect((await setMode('on')).json()).toMatchObject({ mode: 'on' });
    log.appendLog('server', 'a problem');
    log.debugLog('test', 'a debug detail (not on "on")');
    await get('/api/health');
    let text = ((await get('/api/logs/tail?lines=50')).json() as { text: string }).text;
    expect(text).toContain('Log file set to on');
    expect(text).toContain('a problem');
    expect(text).not.toContain('a debug detail');
    expect(text).not.toContain('GET /api/health');

    await setMode('debug');
    log.debugLog('test', 'a debug detail');
    await get('/api/health?token=abc123secret');
    await get('/api/memory/hidden/some/private/file.md');
    text = ((await get('/api/logs/tail?lines=50')).json() as { text: string }).text;
    expect(text).toContain('a debug detail');
    expect(text).toMatch(/\[http\] GET \/api\/health 200 \d+ms/);
    expect(text).not.toContain('abc123secret');
    expect(text).toContain('/api/memory/hidden/…');
    expect(text).not.toContain('private/file.md');
  });

  it('blanks keys, tokens and PINs', () => {
    expect(log.redact('Authorization: Bearer hm_abcdefghijk123')).not.toContain('abcdefghijk123');
    expect(log.redact('{"pin":"4821","apiKey":"xyz987654"}')).not.toMatch(/4821|xyz987654/);
    expect(log.redact('key sk-ant-abcdefghijklmnop used')).not.toContain('abcdefghijklmnop');
    expect(log.redact('the lamp is on')).toBe('the lamp is on');
  });

  it('downloads and clears; off stops writing', async () => {
    const dl = await get('/api/logs/download');
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="hivemind-.*\.log"/);
    expect(dl.body).toContain('a problem');
    const cleared = (await app.inject({ method: 'DELETE', url: '/api/logs', headers: bearer() })).json() as { size: number };
    expect(cleared.size).toBeLessThan(200); // only the "cleared" line
    await setMode('off');
    log.resetLogModeCache(); // the setting survives a restart
    expect(log.logMode()).toBe('off');
    const before = log.logSize().size;
    log.appendLog('server', 'not written');
    expect(log.logSize().size).toBe(before);
  });
});
