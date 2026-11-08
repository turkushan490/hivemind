import { folderOf, groupByFolder } from '@hivemind/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, testApp } from './helpers.js';

let app: FastifyInstance;
let db: Awaited<ReturnType<typeof testApp>>['db'];
beforeAll(async () => {
  ({ app, db } = await testApp('folders'));
});
afterAll(async () => app?.close());

describe('workflow folders', () => {
  it('sorts workflows without a folder by their name or app', () => {
    expect(folderOf({ name: 'HiveBot · Jev' })).toBe('HiveBot');
    expect(folderOf({ name: 'Train a HiveBot character (colibri teaches)' })).toBe('HiveBot');
    expect(folderOf({ name: 'Site: quick change' })).toBe('Websites');
    expect(folderOf({ name: 'Software builder (project)' })).toBe('Software');
    expect(folderOf({ name: 'Deep research: overnight' })).toBe('Research');
    expect(folderOf({ name: 'Research: what do we know?' })).toBe('Research');
    expect(folderOf({ name: 'DungeonMind: narrate' })).toBe('DungeonMind');
    expect(folderOf({ name: 'Colibri: start here' })).toBe('Colibri');
    expect(folderOf({ name: 'Council' })).toBe('Other');
    expect(folderOf({ name: 'Anything', managedBy: 'dungeonmind' })).toBe('DungeonMind');
    expect(folderOf({ name: 'HiveBot · Jev', folder: 'Robots' })).toBe('Robots');
  });

  it('groups folders A–Z with Other last, workflows A–Z inside', () => {
    const g = groupByFolder([{ name: 'Council' }, { name: 'Site: b' }, { name: 'Site: a' }, { name: 'Colibri: start here' }]);
    expect(g.map((x) => x.folder)).toEqual(['Colibri', 'Websites', 'Other']);
    expect(g[1].items.map((x) => x.name)).toEqual(['Site: a', 'Site: b']);
  });

  it('the canvases table has a folder column; the API stores, keeps and clears it', async () => {
    const cols = (db.prepare('PRAGMA table_info(canvases)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('folder');
    const put = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'PUT', url, headers: bearer(), payload });
    const made = (await put('/api/canvases/hb-test', { name: 'HiveBot · Test', nodes: [], edges: [], managedBy: 'hivebot', folder: 'Robots' })).json();
    expect(made.folder).toBe('Robots');
    // Saving without a folder keeps it.
    expect((await put('/api/canvases/hb-test', { name: 'HiveBot · Test', nodes: [], edges: [] })).json().folder).toBe('Robots');
    // An empty folder clears it: sorted by the name again.
    expect((await put('/api/canvases/hb-test', { name: 'HiveBot · Test', nodes: [], edges: [], folder: '' })).json().folder).toBeUndefined();
    expect((await put('/api/canvases/hb-test', { name: 'x', nodes: [], edges: [], folder: 'y'.repeat(41) })).statusCode).toBe(400);
    const list = (await app.inject({ method: 'GET', url: '/api/canvases', headers: bearer() })).json() as { id: string; folder?: string }[];
    expect(list.find((c) => c.id === 'hb-test')).toBeTruthy();
  });
});
