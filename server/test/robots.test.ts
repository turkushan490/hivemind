import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
beforeAll(async () => {
  ({ app } = await testApp('robots', [['u1', 'admin'], ['u2', 'user']]));
});
afterAll(() => app?.close());

const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe('robots (HiveBot devices)', () => {
  let robotId = '';
  let token = '';

  it('an admin adds a robot and gets its own token once', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/robots', headers: bearer('u2'), payload: { name: 'x' } })).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/api/robots', headers: bearer(), payload: { name: 'desk-bot', board: 'cores3', homeSsids: ['Home'], wifi: [{ ssid: 'Home', pass: 'secret-pass' }] } });
    expect(res.statusCode).toBe(200);
    ({ token } = res.json());
    robotId = res.json().robot.id;
    expect(token).toMatch(/^hm_/);
    expect(res.json().robot).toMatchObject({ name: 'desk-bot', online: false, wifi: [{ ssid: 'Home' }] });
    // The list never shows Wi-Fi passwords.
    expect((await app.inject({ method: 'GET', url: '/api/robots', headers: bearer() })).body).not.toContain('secret-pass');
  });

  it('the robot reports in with its token, goes online, and gets its config (with Wi-Fi passwords)', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/robot-urls', headers: bearer(), payload: { home: 'http://hivemind.local:4820', public: 'https://hivemind.example.com' } });
    const hb = await app.inject({ method: 'POST', url: '/api/robot/heartbeat', headers: as(token), payload: { battery: 87, ssid: 'Home', rssi: -55, firmware: '0.4.0' } });
    expect(hb.statusCode).toBe(200);
    expect(hb.json().config).toMatchObject({ name: 'desk-bot', wifi: [{ ssid: 'Home', pass: 'secret-pass' }], urls: { home: 'http://hivemind.local:4820', public: 'https://hivemind.example.com' } });
    const list = (await app.inject({ method: 'GET', url: '/api/robots', headers: bearer() })).json().robots;
    expect(list[0]).toMatchObject({ online: true, battery: 87, firmware: '0.4.0', ssid: 'Home' });
    expect((await app.inject({ method: 'POST', url: '/api/robot/event', headers: as(token), payload: { type: 'button', character: 'jarvis' } })).json()).toMatchObject({ type: 'button', character: 'jarvis' });
  });

  it('a change raises the config version; the robot token can do nothing outside its part', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/robot/config', headers: as(token) })).json().configVersion;
    await app.inject({ method: 'PATCH', url: `/api/robots/${robotId}`, headers: bearer(), payload: { room: 'living_room' } });
    const after = (await app.inject({ method: 'GET', url: '/api/robot/config', headers: as(token) })).json();
    expect(after.configVersion).toBe(before + 1);
    expect(after.room).toBe('living_room');
    expect((await app.inject({ method: 'GET', url: '/api/providers', headers: as(token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/robots', headers: as(token) })).statusCode).toBe(403);
    // Only robots use the robot API: an ordinary token gets a clear 403.
    expect((await app.inject({ method: 'POST', url: '/api/robot/heartbeat', headers: bearer(), payload: {} })).statusCode).toBe(403);
  });

  it('a new token replaces the old one; deleting the robot revokes it', async () => {
    const fresh = (await app.inject({ method: 'POST', url: `/api/robots/${robotId}/token`, headers: bearer() })).json().token;
    expect((await app.inject({ method: 'GET', url: '/api/robot/config', headers: as(token) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/robot/config', headers: as(fresh) })).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: `/api/robots/${robotId}`, headers: bearer() });
    expect((await app.inject({ method: 'GET', url: '/api/robot/config', headers: as(fresh) })).statusCode).toBe(401);
  });
});

describe('installers', () => {
  const put = (path: string, data: string, headers = bearer()) =>
    app.inject({ method: 'PUT', url: `/api/installers/${path}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from(data) });

  it('an app uploads a release with a token that has the installers permission; others may not', async () => {
    const t = (await app.inject({ method: 'POST', url: '/api/tokens', headers: bearer(), payload: { name: 'hivebot build', canvases: ['hivebot*'], installers: true } })).json().token;
    expect((await put('hivebot/v0.9.5/HiveBot.exe', 'MZ exe', as(t))).statusCode).toBe(200);
    expect((await put('hivebot/v0.9.5/run.sh', 'echo', as(t))).statusCode).toBe(400);
    expect((await put('hivebot/v0.9.5/HiveBot.exe', 'MZ', bearer('u2'))).statusCode).toBe(403);
    const list = (await app.inject({ method: 'GET', url: '/api/installers', headers: bearer() })).json().apps;
    expect(list[0]).toMatchObject({ app: 'hivebot', versions: [{ version: 'v0.9.5', files: [{ name: 'HiveBot.exe', size: 6 }] }] });
    const dl = await app.inject({ method: 'GET', url: '/api/installers/hivebot/v0.9.5/HiveBot.exe', headers: bearer() });
    expect(dl.body).toBe('MZ exe');
  });

  it('robot firmware: a manifest for the browser flasher, and the robot is told which firmware to run', async () => {
    for (const p of ['bootloader', 'partitions', 'ota_data_initial', 'firmware']) await put(`hivebot-robot/0.5.0/cores3-${p}.bin`, `${p} bytes`);
    const m = (await app.inject({ method: 'GET', url: '/api/installers/firmware-manifest?board=cores3', headers: bearer() })).json();
    expect(m.builds[0].chipFamily).toBe('ESP32-S3');
    expect(m.builds[0].parts.map((p: { offset: number }) => p.offset)).toEqual([0, 0x8000, 0xf000, 0x20000]);
    const { token } = (await app.inject({ method: 'POST', url: '/api/robots', headers: bearer(), payload: { name: 'bot2', board: 'cores3' } })).json();
    const cfg = (await app.inject({ method: 'GET', url: '/api/robot/config', headers: as(token) })).json();
    expect(cfg.firmware).toMatchObject({ version: '0.5.0', url: '/api/installers/hivebot-robot/0.5.0/cores3-firmware.bin' });
    // The robot may download its firmware, nothing else.
    expect((await app.inject({ method: 'GET', url: cfg.firmware.url, headers: as(token) })).body).toBe('firmware bytes');
    expect((await app.inject({ method: 'GET', url: '/api/installers/hivebot/v0.9.5/HiveBot.exe', headers: as(token) })).statusCode).toBe(403);
  });
});
