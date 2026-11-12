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
  settings: string | null;
  reported: string | null;
  pin_change: string | null;
  reinstall: string | null;
  created_at: string;
}

/** Settings the robot applies at its next heartbeat (H4). */
export interface RobotSettings {
  micSensitivity: number;
  volume: number;
  conversationMode: boolean;
  showText: boolean;
  backlight: { dimAfterS: number; dimPercent: number; lowAfterS: number; lowPercent: number };
}
export const DEFAULT_ROBOT_SETTINGS: RobotSettings = {
  micSensitivity: 5,
  volume: 70,
  conversationMode: true,
  showText: false,
  backlight: { dimAfterS: 180, dimPercent: 20, lowAfterS: 600, lowPercent: 10 },
};

const clampInt = (v: unknown, min: number, max: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(min, Math.min(max, v))) : dflt);
export function cleanSettings(v: unknown, base: RobotSettings = DEFAULT_ROBOT_SETTINGS): RobotSettings {
  const s = (v && typeof v === 'object' ? v : {}) as Partial<RobotSettings> & { backlight?: Partial<RobotSettings['backlight']> };
  const b: Partial<RobotSettings['backlight']> = s.backlight ?? {};
  return {
    micSensitivity: clampInt(s.micSensitivity, 1, 10, base.micSensitivity),
    volume: clampInt(s.volume, 0, 100, base.volume),
    conversationMode: typeof s.conversationMode === 'boolean' ? s.conversationMode : base.conversationMode,
    showText: typeof s.showText === 'boolean' ? s.showText : base.showText,
    backlight: {
      dimAfterS: clampInt(b.dimAfterS, 10, 86400, base.backlight.dimAfterS),
      dimPercent: clampInt(b.dimPercent, 0, 100, base.backlight.dimPercent),
      lowAfterS: clampInt(b.lowAfterS, 10, 86400, base.backlight.lowAfterS),
      lowPercent: clampInt(b.lowPercent, 0, 100, base.backlight.lowPercent),
    },
  };
}
const settingsOf = (r: RobotRow): RobotSettings => {
  try {
    return cleanSettings(r.settings ? JSON.parse(r.settings) : {});
  } catch {
    return { ...DEFAULT_ROBOT_SETTINGS };
  }
};

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
  lastEvent?: { type: string; character?: string; version?: string; error?: string; at: string };
  configVersion: number;
  /** The firmware version the robot should update to (Installers → Update firmware). */
  firmwareTarget?: string;
  settings: RobotSettings;
  /** What the robot says it uses now (it can also change them by voice). */
  reported?: Partial<RobotSettings>;
  /** A PIN change sent over the air that the robot hasn't confirmed yet. */
  pinPending: boolean;
  /** A firmware reinstall sent over the air that the robot hasn't confirmed yet (H8). */
  reinstallPending?: { version: string; id: number };
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
    settings: settingsOf(r),
    ...(r.reported && { reported: JSON.parse(r.reported) as Partial<RobotSettings> }),
    pinPending: !!r.pin_change,
    ...(r.reinstall && { reinstallPending: JSON.parse(r.reinstall) as { version: string; id: number } }),
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
export function updateRobot(ownerId: string, id: string, body: { name?: unknown; room?: unknown; homeSsids?: unknown; wifi?: unknown; board?: unknown; firmwareTarget?: unknown; settings?: unknown }): Robot {
  const r = getRobot(ownerId, id);
  if (body.settings !== undefined) db.prepare('UPDATE robots SET settings = ? WHERE id = ?').run(JSON.stringify(cleanSettings(body.settings, settingsOf(r))), id);
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
  // A reinstall (H8) overrides the firmware block: its chosen version, plus a `reinstall` id so the robot puts it on
  // again even when it is the same or older than what it runs. Otherwise the normal firmware it should be running.
  const reinstall = r.reinstall ? (JSON.parse(r.reinstall) as { version: string; id: number }) : undefined;
  const fw = reinstall
    ? (() => {
        const f = firmwareFor?.(r.board, reinstall.version);
        return f ? { ...f, reinstall: reinstall.id } : firmwareFor?.(r.board, r.firmware_target);
      })()
    : firmwareFor?.(r.board, r.firmware_target);
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
      { id: 'ghost', wakeWord: 'ghost' },
    ],
    standby: { askAfterS: 240, sleepAfterS: 600 },
    settings: settingsOf(r),
    ...(r.pin_change && { pinChange: JSON.parse(r.pin_change) as { salt: string; hash: string; id: number } }),
    ...(fw && { firmware: fw }),
  };
}

/**
 * Put a firmware version on the robot again over the air (H8): the same version (a broken install) or an older one
 * (roll back), without a USB cable. Only {version, id} is stored; the robot installs it even when it is not newer,
 * then confirms with reinstallId in its heartbeat. The caller (API) checks the version has a <board>-firmware.bin.
 */
export function setReinstall(ownerId: string, id: string, version: string): { id: number } {
  getRobot(ownerId, id);
  const change = { version, id: Date.now() % 2_000_000_000 };
  db.prepare('UPDATE robots SET reinstall = ?, config_version = config_version + 1 WHERE id = ?').run(JSON.stringify(change), id);
  return { id: change.id };
}

/**
 * A new unlock PIN over the air (H2): only a salt and SHA-256(salt || digits) go to the robot, the robot's own
 * scheme; HiveMind keeps them until the robot confirms (pinId in its heartbeat), then forgets them. The digits are
 * never stored.
 */
export function changePin(ownerId: string, id: string, digits: unknown): { id: number } {
  if (typeof digits !== 'string' || !/^\d{4,8}$/.test(digits)) throw err(400, 'The PIN is 4 to 8 digits');
  getRobot(ownerId, id);
  const salt = randomBytes(16);
  const hash = createHash('sha256').update(salt).update(digits).digest('hex');
  const change = { salt: salt.toString('hex'), hash, id: Date.now() % 2_000_000_000 };
  db.prepare('UPDATE robots SET pin_change = ?, config_version = config_version + 1 WHERE id = ?').run(JSON.stringify(change), id);
  return { id: change.id };
}

/** Heartbeat: what the robot says about itself; answers with its config (it re-reads when the version changed). */
export function heartbeat(r: RobotRow, body: Record<string, unknown>, ip: string | undefined) {
  db.prepare(
    `UPDATE robots SET last_seen = datetime('now'), battery = COALESCE(?, battery), firmware = COALESCE(?, firmware), ssid = COALESCE(?, ssid), rssi = COALESCE(?, rssi), ip = COALESCE(?, ip), board = COALESCE(?, board) WHERE id = ?`,
  ).run(num(body.battery, 0, 100), str(body.firmware, 40), str(body.ssid, 32), num(body.rssi, -150, 0), ip ?? null, str(body.board, 40), r.id);
  if (body.moved === true) robotEvent(r, { type: 'moved' });
  // What it uses now (H4), and a PIN change it has taken over (H2): then HiveMind forgets the hash.
  if (body.settings && typeof body.settings === 'object') db.prepare('UPDATE robots SET reported = ? WHERE id = ?').run(JSON.stringify(cleanSettings(body.settings)), r.id);
  if (r.pin_change && typeof body.pinId === 'number' && (JSON.parse(r.pin_change) as { id: number }).id === body.pinId)
    db.prepare('UPDATE robots SET pin_change = NULL WHERE id = ?').run(r.id);
  // A firmware reinstall the robot has taken (H8): drop it and show the result on its card.
  if (r.reinstall && typeof body.reinstallId === 'number') {
    const pending = JSON.parse(r.reinstall) as { version: string; id: number };
    if (pending.id === body.reinstallId) {
      db.prepare('UPDATE robots SET reinstall = NULL WHERE id = ?').run(r.id);
      const error = str(body.reinstallError, 200);
      robotEvent(r, { type: error ? 'reinstall_failed' : 'reinstalled', version: pending.version, ...(error && { error }) });
    }
  }
}

export function robotEvent(r: RobotRow, body: { type?: unknown; character?: unknown; version?: unknown; error?: unknown }) {
  const type = str(body.type, 30);
  if (!type) throw err(400, 'type is required ("moved", "button", "battery_low", "wake")');
  const ev = {
    type,
    ...(str(body.character, 20) && { character: str(body.character, 20)! }),
    ...(str(body.version, 40) && { version: str(body.version, 40)! }),
    ...(str(body.error, 200) && { error: str(body.error, 200)! }),
    at: new Date().toISOString(),
  };
  db.prepare('UPDATE robots SET last_event = ? WHERE id = ?').run(JSON.stringify(ev), r.id);
  return ev;
}
