import type { HomeAssistantSettings } from '@hivemind/shared';
import { decrypt, encrypt } from '../crypto.js';
import { getSetting, setSetting } from '../db/index.js';

/** Home Assistant connection for Home Assistant blocks: one per HiveMind, token stored encrypted like provider keys. */
interface Stored {
  url?: string;
  tokenEnc?: string;
}

const KEY = 'homeassistant';

function load(): Stored {
  try {
    return JSON.parse(getSetting(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function homeAssistantSettings(): HomeAssistantSettings {
  const s = load();
  return { url: s.url, hasToken: !!s.tokenEnc };
}

/** An empty token removes it, undefined keeps it. */
export function saveHomeAssistantSettings(patch: { url?: string; token?: string }) {
  const s = load();
  const url = patch.url !== undefined ? patch.url.trim().replace(/\/+$/, '').replace(/\/api$/, '') || undefined : s.url;
  if (url && !/^https?:\/\//i.test(url)) throw new Error('The Home Assistant address must start with http:// or https://');
  setSetting(
    KEY,
    JSON.stringify({
      url,
      tokenEnc: patch.token !== undefined ? (patch.token.trim() ? encrypt(patch.token.trim()) : undefined) : s.tokenEnc,
    }),
  );
}

/** Address and token for calls, or undefined when not set up. */
export function homeAssistantConnection(): { url: string; token: string } | undefined {
  const s = load();
  if (!s.url || !s.tokenEnc) return;
  return { url: s.url, token: decrypt(s.tokenEnc) };
}
