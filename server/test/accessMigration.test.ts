import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An install from before access profiles and file owners: existing users get Basic, the admin's tokens keep
 * Everything, other tokens get no profile of their own, and the files already in the folder go to the first admin.
 */
describe('access migration', () => {
  it('upgrades an existing install', async () => {
    // The migrations as they were before this change, read without opening the app's database.
    const dir = mkdtempSync(join(tmpdir(), 'hm-migrate-'));
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/db/index.ts', import.meta.url), 'utf8'));
    const list = source.slice(source.indexOf('export const MIGRATIONS'), source.indexOf('];\n', source.indexOf('export const MIGRATIONS')));
    const all = [...list.matchAll(/`([\s\S]*?)`,/g)].map((m) => m[1]);
    const old = all.slice(0, -1);
    expect(all.at(-1)).toMatch(/access_profiles/);

    const pre = new DatabaseSync(join(dir, 'hivemind.db'));
    for (const m of old) pre.exec(m);
    pre.exec(`PRAGMA user_version = ${old.length}`);
    pre.exec(`
      INSERT INTO users (id, username, pw_hash, role, created_at) VALUES ('boss', 'boss', 'x', 'admin', '2025-01-01'), ('pat', 'pat', 'x', 'user', '2025-02-01'), ('vic', 'vic', 'x', 'viewer', '2025-03-01');
      INSERT INTO api_tokens (id, user_id, name, token_hash, prefix) VALUES ('t-boss', 'boss', 'DungeonMind', 'h1', 'hm_'), ('t-pat', 'pat', 'phone', 'h2', 'hm_');
      INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('ollama', 'ollama', 'ollama', 'Ollama', 'http://gpu.test:11434', 1);
      INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('comfy', 'comfyui', 'comfyui', 'ComfyUI', 'http://gpu.test:8188', 1);
      INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('jev', 'typesafe', 'decision', 'Jev', 'https://decide.test', 0);
      INSERT INTO providers (id, preset, kind, name, base_url, local) VALUES ('or', 'openrouter', 'openai', 'OpenRouter', 'https://openrouter.test', 0);
      INSERT INTO providers (id, preset, kind, name, base_url, local, owner_id) VALUES ('mine', 'groq', 'openai', 'My Groq', 'https://groq.test', 0, 'pat');
    `);
    pre.close();
    mkdirSync(join(dir, 'files', 'outputs'), { recursive: true });
    writeFileSync(join(dir, 'files', 'outputs', 'image-old.png'), 'x');
    writeFileSync(join(dir, 'files', 'notes.md'), 'x');

    process.env.DATA_DIR = dir;
    const { buildApp } = await import('../src/app.js');
    const { db } = await import('../src/db/index.js');
    const app = await buildApp({ logger: false, web: false });

    const users = Object.fromEntries((db.prepare('SELECT id, profile_id FROM users').all() as { id: string; profile_id: string | null }[]).map((u) => [u.id, u.profile_id]));
    expect(users).toEqual({ boss: null, pat: 'basic', vic: 'basic' });
    const tokens = Object.fromEntries((db.prepare('SELECT id, profile_id FROM api_tokens').all() as { id: string; profile_id: string | null }[]).map((t) => [t.id, t.profile_id]));
    expect(tokens).toEqual({ 't-boss': 'everything', 't-pat': null });
    // Basic: the shared cloud providers with all models, nothing from Ollama, ComfyUI or decision models.
    const basic = JSON.parse((db.prepare("SELECT providers FROM access_profiles WHERE id = 'basic'").get() as { providers: string }).providers);
    expect(basic).toEqual({ or: { models: 'all', loras: 'none' } });
    const files = db.prepare('SELECT path, owner_id FROM files ORDER BY path').all() as { path: string; owner_id: string }[];
    expect(files.map((f) => ({ ...f }))).toEqual([
      { path: 'notes.md', owner_id: 'boss' },
      { path: 'outputs/image-old.png', owner_id: 'boss' },
    ]);
    const { allowedFor } = await import('../src/services/access.js');
    const pat = allowedFor({ id: 'pat', role: 'user' });
    expect([pat.provider('or'), pat.provider('mine'), pat.provider('ollama'), pat.provider('comfy'), pat.provider('jev')]).toEqual([true, true, false, false, false]);
    expect(allowedFor({ id: 'boss', role: 'admin', tokenId: 't-boss' }).everything).toBe(true);
    await app.close();
  });
});
