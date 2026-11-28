import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testApp } from './helpers.js';

/** GitHub's file servers sometimes break off a big download ("terminated"): each file is tried again. */

let app: Awaited<ReturnType<typeof testApp>>['app'];
let inst: typeof import('../src/services/installers.js');
let fails = 0;
let calls = 0;

beforeAll(async () => {
  ({ app } = await testApp('githubretry', [['a1', 'admin']]));
  inst = await import('../src/services/installers.js');
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/releases/latest'))
      return Response.json({ tag_name: 'v9.9.9', assets: [{ name: 'Thing.exe', url: 'https://gh.test/asset/1', size: 5 }] });
    if (url === 'https://gh.test/asset/1') {
      calls++;
      if (fails-- > 0) throw new TypeError('terminated');
      return new Response('hello');
    }
    return new Response('not found', { status: 404 });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  return app?.close();
});

describe('GitHub release download', () => {
  it('tries a broken-off file again', async () => {
    inst.setGithubRepo('thing', 'me/thing');
    fails = 2;
    const r = await inst.fetchGithubRelease('thing', undefined);
    expect(r.files).toEqual(['Thing.exe']);
    expect(calls).toBe(3);
  }, 30_000);

  it('gives up after 4 tries', async () => {
    fails = 10;
    calls = 0;
    await expect(inst.fetchGithubRelease('thing', undefined)).rejects.toThrow(/broke off 4 times/);
    expect(calls).toBe(4);
  }, 60_000);
});
