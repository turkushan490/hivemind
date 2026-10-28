import { describe, expect, it } from 'vitest';
import { validateGraph } from '../src/engine/graph.js';
import { TEMPLATES } from '../../web/src/canvas/templates.js';

const models = { text: [{ providerId: 'p', model: 'small' }, { providerId: 'p', model: 'medium' }], judge: { providerId: 'p', model: 'big' }, image: { providerId: 'c', model: 'img' }, decision: { providerId: 'ts', model: 'jev-latest' } };

describe('canvas templates', () => {
  it('every template builds a valid graph when models are filled in', () => {
    for (const t of TEMPLATES) expect(() => validateGraph(t.build(models)), t.id).not.toThrow();
  });

  it('has the Tabletop set with the DungeonMind block labels', () => {
    const ids = TEMPLATES.filter((t) => t.group === 'Tabletop').map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['dnd-setup', 'dnd-adjudicate', 'dnd-narrate', 'dnd-chronicle', 'dnd-ask', 'dnd-sheet', 'dnd-portrait']));
    const narrate = TEMPLATES.find((t) => t.id === 'dnd-narrate')!.build(models);
    const byLabel = Object.fromEntries(narrate.nodes.map((n) => [n.label, n]));
    expect(byLabel.narration.config.numCtx).toBe(32768);
    expect(byLabel.state.config.json).toBe(true);
    expect(byLabel.remember.config).toMatchObject({ key: 'dnd:{{vars.tableId}}', mode: 'save' });
    expect(TEMPLATES.find((t) => t.id === 'dnd-portrait')!.build(models).nodes.find((n) => n.type === 'image')!.config.batch).toBe(4);
  });
});
