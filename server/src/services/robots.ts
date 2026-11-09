import { createHash, randomBytes } from 'node:crypto';
import { decrypt, encrypt, newId } from '../crypto.js';
import { db, getSetting } from '../db/index.js';
import type { TokenScope } from '../api/auth.js';

/**
 * Robots (HiveBot devices): each has its own API token, limited to /api/robot/*, the voice API and the HiveBot
 * workflows, so a lost robot is revoked on its own. A robot reports in every minute (heartbeat: battery, Wi-Fi,
 * firmware) and gets its config back (Wi-Fi networks, HiveMind addresses, room, the firmware it should run).
 */

export interface RobotRow {
  id: string;
  name: string;
  owner_id: string;
  token_id: string | null;
  board: string | null;
  room: string | null;
  home_ssids: string;
  wifi_enc: string | null;
  last_seen: string | null;
  battery: number | null;
  firmware: string | null;
  ip: string | null;
  ssid: string | null;
  rssi: number | null;
  last_event: string | null;
  config_version: number;
  firmware_target: string | null;
  created_at: string;
}

export interface Robot {
  id: string;
  name: string;
  board?: string;
  room?: string;
  homeSsids: string[];
  wifi: { ssid: string }[];
  online: boolean;
  lastSeen?: string;
  battery?: number;
  firmware?: string;
  ip?: string;
  ssid?: string;
  rssi?: number;
  lastEvent?: { type: string; character?: string; at: string };
  configVersion: number;
  /** The firmware version the robot should update to (Installers → Update firmware). */
  firmwareTarget?: string;
  createdAt: string;
}

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const ONLINE_MS = 2 * 60_000;

const wifiOf = (r: RobotRow): { ssid: string; pass: string }[] => {
  if (!r.wifi_enc) return [];
  try {
    return JSON.parse(decrypt(r.wifi_enc)) as { ssid: string; pass: string }[];
  } catch {
    return [];
  }
};

export function toRobot(r: RobotRow): Robot {
  const seen = r.last_seen ? Date.parse(`${r.last_seen.replace(' ', 'T')}Z`) : 0;
  let lastEvent: Robot['lastEvent'];
  try {
    lastEvent = r.last_event ? (JSON.parse(r.last_event) as Robot['lastEvent']) : undefined;
  } catch {}
  return {
    id: r.id,
    name: r.name,
    ...(r.board && { board: r.board }),
    ...(r.room && { room: r.room }),
    homeSsids: JSON.parse(r.home_ssids || '[]') as string[],
    wifi: wifiOf(r).map((w) => ({ ssid: w.ssid })),
    online: !!seen && Date.now() - seen < ONLINE_MS,
    ...(r.last_seen && { lastSeen: `${r.last_seen.replace(' ', 'T')}Z` }),
    ...(r.battery !== null && { battery: r.battery }),
    ...(r.firmware && { firmware: r.firmware }),
    ...(r.ip && { ip: r.ip }),
    ...(r.ssid && { ssid: r.ssid }),
    ...(r.rssi !== null && { rssi: r.rssi }),
    ...(lastEvent && { lastEvent }),
    configVersion: r.config_version,
    ...(r.firmware_target && { firmwareTarget: r.firmware_target }),
    createdAt: r.created_at,
  };
}

export const listRobots = (ownerId: string): Robot[] =>
  (db.prepare('SELECT * FROM robots WHERE owner_id = ? ORDER BY created_at').all(ownerId) as unknown as RobotRow[]).map(toRobot);

export function getRobot(ownerId: string, id: string): RobotRow {
  const r = db.prepare('SELECT * FROM robots WHERE id = ? AND owner_id = ?').get(id, ownerId) as RobotRow | undefined;
  if (!r) throw err(404, 'No such robot');
  return r;
}

export const robotById = (id: string) => db.prepare('SELECT * FROM robots WHERE id = ?').get(id) as RobotRow | undefined;

const cleanName = (n: unknown) => {
  const s = String(n ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 60);
  if (!s) throw err(400, 'Give the robot a name');
  return s;
};

const cleanList = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length > 64)) throw err(400, `${what} must be a list of names`);
  return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))].slice(0, 20);
};

const cleanWifi = (v: unknown): { ssid: string; pass: string }[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw err(400, 'wifi must be a list of { ssid, pass }');
  return (v as { ssid?: unknown; pass?: unknown }[]).slice(0, 10).map((w) => {
    if (typeof w?.ssid !== 'string' || !w.ssid.trim() || w.ssid.length > 32) throw err(400, 'Every Wi-Fi network needs a name (at most 32 characters)');
    if (w.pass !== undefined && (typeof w.pass !== 'string' || w.pass.length > 64)) throw err(400, 'A Wi-Fi password has at most 64 characters');
    return { ssid: w.ssid.trim(), pass: String(w.pass ?? '') };
  });
};

/** A robot's token: its own, limited to the robot API, the voice API and the HiveBot workflows and memory. */
function makeToken(ownerId: string, robotId: string, name: string): { id: string; token: string } {
  const token = `hm_${randomBytes(24).toString('base64url')}`;
  const id = newId();
  const scope: TokenScope = { canvases: ['hivebot*'], memory: ['hivebot*'], robot: robotId };
  db.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    ownerId,
    `Robot: ${name}`,
    createHash('sha256').update(token).digest('hex'),
    token.slice(0, 7),
    JSON.stringify(scope),
  );
  return { id, token };
}

/** Adds a robot; its token is in the answer this once only. */
export function createRobot(ownerId: string, body: { name?: unknown; board?: unknown; room?: unknown; homeSsids?: unknown; wifi?: unknown }): { robot: Robot; token: string } {
  const name = cleanName(body.name);
  const id = `rb_${newId().replace(/[^a-zA-Z0-9]/g, 'x')}`;
  const wifi = cleanWifi(body.wifi);
  const { id: tokenId, token } = makeToken(ownerId, id, name);
  db.prepare('INSERT INTO robots (id, name, owner_id, token_id, board, room, home_ssids, wifi_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    name,
    ownerId,
    tokenId,
    typeof body.board === 'string' ? body.board.slice(0, 40) : null,
    typeof body.room === 'string' && body.room.trim() ? body.room.trim().slice(0, 60) : null,
    JSON.stringify(cleanList(body.homeSsids, 'homeSsids')),
    wifi.length ? encrypt(JSON.stringify(wifi)) : null,
  );
  return { robot: toRobot(getRobot(ownerId, id)), token };
}

/** Changes name, room, home networks or Wi-Fi; the robot picks it up at its next heartbeat (new config version). */
export function updateRobot(ownerId: string, id: string, body: { name?: unknown; room?: unknown; homeSsids?: unknown; wifi?: unknown; board?: unknown; firmwareTarget?: unknown }): Robot {
  const r = getRobot(ownerId, id);
  const wifi = body.wifi !== undefined ? cleanWifi(body.wifi) : undefined;
  db.prepare(
    `UPDATE robots SET name = ?, room = ?, home_ssids = ?, wifi_enc = ?, board = ?, firmware_target = ?, config_version = config_version + 1 WHERE id = ?`,
  ).run(
    body.name !== undefined ? cleanName(body.name) : r.name,
    body.room !== undefined ? (typeof body.room === 'string' && body.room.trim() ? body.room.trim().slice(0, 60) : null) : r.room,
    body.homeSsids !== undefined ? JSON.stringify(cleanList(body.homeSsids, 'homeSsids')) : r.home_ssids,
    wifi !== undefined ? (wifi.length ? encrypt(JSON.stringify(wifi)) : null) : r.wifi_enc,
    body.board !== undefined ? (typeof body.board === 'string' ? body.board.slice(0, 40) : null) : r.board,
    body.firmwareTarget !== undefined ? (typeof body.firmwareTarget === 'string' && body.firmwareTarget ? body.firmwareTarget.slice(0, 40) : null) : r.firmware_target,
    id,
  );
  return toRobot(getRobot(ownerId, id));
}

/** A new token for the robot (the old one stops working). */
export function newRobotToken(ownerId: string, id: string): string {
  const r = getRobot(ownerId, id);
  if (r.token_id) db.prepare('DELETE FROM api_tokens WHERE id = ?').run(r.token_id);
  const { id: tokenId, token } = makeToken(ownerId, id, r.name);
  db.prepare('UPDATE robots SET token_id = ? WHERE id = ?').run(tokenId, id);
  return token;
}

export function deleteRobot(ownerId: string, id: string) {
  const r = getRobot(ownerId, id);
  if (r.token_id) db.prepare('DELETE FROM api_tokens WHERE id = ?').run(r.token_id);
  db.prepare('DELETE FROM robots WHERE id = ?').run(id);
}

// ---- what the robot itself calls (with its own token) ----

const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : null);
const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** The robot's config: Wi-Fi networks (with passwords), HiveMind addresses, room, characters, firmware to run. */
export function robotConfig(r: RobotRow, firmwareFor?: (board: string | null, target: string | null) => { version: string; url: string; sha256?: string } | undefined) {
  const urls = (() => {
    try {
      return JSON.parse(getSetting('robot.urls') ?? '{}') as { home?: string; public?: string };
    } catch {
      return {};
    }
  })();
  const fw = firmwareFor?.(r.board, r.firmware_target);
  return {
    configVersion: r.config_version,
    name: r.name,
    wifi: wifiOf(r),
    urls,
    room: r.room ?? null,
    homeSsids: JSON.parse(r.home_ssids || '[]') as string[],
    characters: [
      { id: 'jev', wakeWord: 'jev' },
      { id: 'jarvis', wakeWord: 'hey jarvis' },
      { id: 'ultron', wakeWord: 'ultron' },
      { id: 'vision', wakeWord: 'vision' },
    ],
    standby: { askAfterS: 240, sleepAfterS: 600 },
    ...(fw && { firmware: fw }),
  };
}

/** Heartbeat: what the robot says about itself; answers with its config (it re-reads when the version changed). */
export function heartbeat(r: RobotRow, body: Record<string, unknown>, ip: string | undefined) {
  db.prepare(
    `UPDATE robots SET last_seen = datetime('now'), battery = COALESCE(?, battery), firmware = COALESCE(?, firmware), ssid = COALESCE(?, ssid), rssi = COALESCE(?, rssi), ip = COALESCE(?, ip), board = COALESCE(?, board) WHERE id = ?`,
  ).run(num(body.battery, 0, 100), str(body.firmware, 40), str(body.ssid, 32), num(body.rssi, -150, 0), ip ?? null, str(body.board, 40), r.id);
  if (body.moved === true) robotEvent(r, { type: 'moved' });
}

export function robotEvent(r: RobotRow, body: { type?: unknown; character?: unknown }) {
  const type = str(body.type, 30);
  if (!type) throw err(400, 'type is required ("moved", "button", "battery_low", "wake")');
  const ev = { type, ...(str(body.character, 20) && { character: str(body.character, 20)! }), at: new Date().toISOString() };
  db.prepare('UPDATE robots SET last_event = ? WHERE id = ?').run(JSON.stringify(ev), r.id);
  return ev;
}
