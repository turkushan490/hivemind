import { accessSync, chownSync, constants, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_NUM_CTX } from './v1Models.js';

/**
 * Settings → T3 Code: which HiveMind models T3 Code (through OpenCode) offers, written into OpenCode's config
 * (`opencode.json`, provider "hivemind"). HiveMind reaches that file through an optional folder mapping
 * (T3_OPENCODE_DIR, default /t3/opencode); everything outside provider.hivemind stays as it is.
 */

export const T3_ROLES = ['fast', 'planner', 'coder', 'slow', 'check'] as const;
export type T3Role = (typeof T3_ROLES)[number];
export const ROLE_LABEL: Record<T3Role, string> = { fast: 'fast', planner: 'planner', coder: 'coder', slow: 'slow + best', check: 'check' };

/** One chosen model: optional own name, description, role and thinking switch. */
export interface T3Choice {
  name?: string;
  description?: string;
  role?: T3Role;
  reasoning?: boolean;
}

export interface T3Settings {
  /** The /v1 address OpenCode (inside T3's container) uses to reach HiveMind. */
  baseUrl?: string;
  /** "uid:gid" for written files; T3 runs as Unraid's nobody:users. */
  owner?: string;
  /** The API token made for T3 (so New token can revoke it). */
  tokenId?: string;
  models: Record<string, T3Choice>;
}

/** A /v1/models entry as the page and the writer see it. */
export interface T3Model {
  id: string;
  name: string;
  /** Model name without the provider (single models), or the workflow's name. */
  modelName: string;
  provider: string;
  providerName: string;
  kind: 'model' | 'workflow';
  local: boolean;
  tools: boolean;
  contextLength?: number;
  sizeBytes?: number;
  description?: string;
}

export const DEFAULT_OWNER = '99:100';
export const T3_TOKEN_FILE = 'hivemind-token';
const CONFIG_FILE = 'opencode.json';
const BACKUP_FILE = 'opencode.json.hivemind-backup';

export const t3Dir = () => process.env.T3_OPENCODE_DIR || '/t3/opencode';

/** The /v1/models answer as rows for the page. */
export function t3Models(data: { id: string; name: string; owned_by?: string; description?: string; hivemind?: Record<string, unknown> }[]): T3Model[] {
  return data.map((d) => {
    const h = d.hivemind as { kind?: string; provider?: string; providerKind?: string; modelName?: string; local?: boolean; tools?: boolean; contextLength?: number; sizeBytes?: number } | undefined;
    if (h?.kind === 'model')
      return {
        id: d.id,
        name: d.name,
        modelName: h.modelName ?? d.name,
        provider: h.providerKind ?? h.provider ?? '',
        providerName: d.owned_by ?? '',
        kind: 'model',
        local: h.local === true,
        tools: h.tools === true,
        ...(h.contextLength && { contextLength: h.contextLength }),
        ...(h.sizeBytes && { sizeBytes: h.sizeBytes }),
      };
    return { id: d.id, name: d.name, modelName: d.name, provider: 'workflow', providerName: 'Workflow', kind: 'workflow', local: true, tools: false, ...(d.description && { description: d.description }) };
  });
}

const GB = 1e9;

/** Where it runs, as shown in T3: GPU, GPU+CPU (bigger than the card), Colibri CPU, cloud or workflow. */
export function whereLabel(m: T3Model): string {
  if (m.kind === 'workflow') return 'workflow';
  if (m.provider.startsWith('colibri')) return 'Colibri CPU';
  if (m.provider === 'ollama') return (m.sizeBytes ?? 0) > 15 * GB ? 'GPU+CPU' : 'GPU';
  return m.local ? 'local' : 'cloud';
}

/** A short description when the user wrote none: from the kind, size and tools. */
export function defaultDescription(m: T3Model): string {
  if (m.kind === 'workflow') return m.description ? `${m.description.slice(0, 50)}, chat only` : 'workflow, chat only';
  if (!m.tools) return 'chat only, no file edits';
  if (m.provider.startsWith('colibri')) return 'big model on the CPU, slow';
  if (!m.local) return 'cloud model';
  const size = m.sizeBytes ?? 0;
  if (!size) return 'local model';
  if (size < 5 * GB) return 'very fast: simple code, quick checks';
  if (size < 10 * GB) return 'fast: plans, normal code, review';
  if (size < 20 * GB) return 'strong: plans with thinking, code';
  return 'best local, slow: hard code';
}

/** Models that can think (OpenCode then offers a reasoning setting), unless the user said otherwise. */
export function thinks(m: T3Model, choice?: T3Choice): boolean {
  if (choice?.reasoning !== undefined) return choice.reasoning;
  return /qwen3|deepseek|gpt-oss|gemini|\br1\b|think|reason|glm|kimi|magistral/i.test(`${m.id} ${m.modelName}`);
}

/** The name T3 shows: "<name> · <where> · <role> (<description>)", without the role when there is none. */
export function t3Name(m: T3Model, choice: T3Choice = {}): string {
  const name = choice.name?.trim() || m.modelName;
  const desc = choice.description?.trim() || defaultDescription(m);
  const role = choice.role ? ` · ${ROLE_LABEL[choice.role]}` : '';
  return `${name} · ${whereLabel(m)}${role} (${desc})`;
}

/** The context OpenCode may fill: what HiveMind really gives API calls. */
export function contextFor(m: T3Model): number {
  if (m.provider === 'ollama') return API_NUM_CTX;
  return m.contextLength ?? API_NUM_CTX;
}

/** OpenCode's provider block for the chosen models (ones no longer offered are left out). */
export function hivemindBlock(models: T3Model[], settings: T3Settings, baseUrl: string) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [id, choice] of Object.entries(settings.models)) {
    const m = byId.get(id);
    if (!m) continue;
    entries[id] = {
      name: t3Name(m, choice),
      tool_call: m.tools,
      ...(thinks(m, choice) && m.kind === 'model' && { reasoning: true }),
      ...(m.kind === 'model' && { limit: { context: contextFor(m), output: m.local ? 8192 : 16384 } }),
    };
  }
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'HiveMind',
    options: { baseURL: baseUrl, apiKey: `{file:~/.config/opencode/${T3_TOKEN_FILE}}` },
    models: entries,
  };
}

/** The new opencode.json: the old one with only provider.hivemind replaced. Throws on a file that isn't JSON. */
export function mergeConfig(existingText: string | undefined, block: ReturnType<typeof hivemindBlock>): Record<string, unknown> {
  let cfg: Record<string, unknown> = {};
  if (existingText?.trim()) {
    const parsed = JSON.parse(existingText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('opencode.json is not a JSON object');
    cfg = parsed as Record<string, unknown>;
  }
  const provider = cfg.provider && typeof cfg.provider === 'object' && !Array.isArray(cfg.provider) ? (cfg.provider as Record<string, unknown>) : {};
  return { $schema: 'https://opencode.ai/config.json', ...cfg, provider: { ...provider, hivemind: block } };
}

export interface T3FolderStatus {
  dir: string;
  mapped: boolean;
  configExists: boolean;
  /** Model ids under provider.hivemind in the file now. */
  inFile: string[];
  baseUrlInFile?: string;
  writtenAt?: string;
  tokenPresent: boolean;
  error?: string;
}

/** What the mapped folder holds now. */
export function folderStatus(dir = t3Dir()): T3FolderStatus {
  const mapped = (() => {
    try {
      accessSync(dir, constants.W_OK);
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  })();
  const status: T3FolderStatus = { dir, mapped, configExists: false, inFile: [], tokenPresent: false };
  if (!mapped) return status;
  const file = join(dir, CONFIG_FILE);
  try {
    status.tokenPresent = readFileSync(join(dir, T3_TOKEN_FILE), 'utf8').trim().length > 0;
  } catch {}
  if (!existsSync(file)) return status;
  status.configExists = true;
  try {
    status.writtenAt = statSync(file).mtime.toISOString();
    const cfg = JSON.parse(readFileSync(file, 'utf8')) as { provider?: { hivemind?: { models?: Record<string, unknown>; options?: { baseURL?: string } } } };
    status.inFile = Object.keys(cfg.provider?.hivemind?.models ?? {});
    status.baseUrlInFile = cfg.provider?.hivemind?.options?.baseURL;
  } catch (err) {
    status.error = `opencode.json can't be read: ${(err as Error).message}`;
  }
  return status;
}

/** "99:100" → numbers, or undefined when it isn't that shape. */
export function parseOwner(owner: string | undefined): { uid: number; gid: number } | undefined {
  const m = /^(\d+):(\d+)$/.exec((owner ?? '').trim());
  return m ? { uid: Number(m[1]), gid: Number(m[2]) } : undefined;
}

/** Writes a file in the folder safely (temp file, then rename) and gives it the owner; returns a warning if chown failed. */
function writeOwned(dir: string, name: string, text: string, owner: string | undefined, mode?: number): string | undefined {
  const path = join(dir, name);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined);
  renameSync(tmp, path);
  const o = parseOwner(owner);
  if (!o) return undefined;
  try {
    chownSync(path, o.uid, o.gid);
  } catch (err) {
    return `Could not give ${name} the owner ${owner} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); T3 may not be able to read it.`;
  }
  return undefined;
}

/** Writes opencode.json (keeping one backup); returns the warnings. */
export function writeConfig(cfg: Record<string, unknown>, owner: string | undefined, dir = t3Dir()): string[] {
  const warnings: string[] = [];
  const file = join(dir, CONFIG_FILE);
  if (existsSync(file)) copyFileSync(file, join(dir, BACKUP_FILE));
  const w = writeOwned(dir, CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, owner);
  if (w) warnings.push(w);
  return warnings;
}

/** Writes the API token file (mode 600); returns a warning if chown failed. */
export function writeToken(token: string, owner: string | undefined, dir = t3Dir()): string | undefined {
  return writeOwned(dir, T3_TOKEN_FILE, `${token}\n`, owner, 0o600);
}
