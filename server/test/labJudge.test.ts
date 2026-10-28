import { describe, expect, it } from 'vitest';
import { parseVerdict, readFastPass } from '../src/lab/judge.js';
import { applyTurn, setupGame } from '../src/lab/sim.js';
import { Party } from '../src/lab/state.js';

describe('judge verdict parser', () => {
  it('reads a clean verdict', () => {
    const v = parseVerdict('{"errors":[{"type":"resource","detail":"Channel Divinity used at 0/1"}],"story":7,"corrected":{"narration":"fixed"}}');
    expect(v).toEqual({ errors: [{ type: 'resource', detail: 'Channel Divinity used at 0/1' }], story: 7, corrected: '{"narration":"fixed"}' });
  });

  it('forgives fences, chatter, strings and loose type names', () => {
    const v = parseVerdict('Here you go:\n```json\n{"errors":["missing roll for the attack", {"type":"Invented number","detail":"says 12 damage"}, {"type":"weird"}], "story_score": "11"}\n```');
    expect(v.errors.map((e) => e.type)).toEqual(['roll', 'number']);
    expect(v.story).toBe(10);
    expect(v.corrected).toBeUndefined();
  });

  it('no errors means no corrected turn', () => {
    expect(parseVerdict('{"errors":[],"story":8,"corrected":{"narration":"x"}}')).toEqual({ errors: [], story: 8 });
  });

  it('throws on a verdict that is not JSON', () => {
    expect(() => parseVerdict('looks fine to me')).toThrow(/not JSON/);
  });

  it('reads the Jev fast pass: flags at p ≥ 0.5 and a 1-10 story score', () => {
    const f = readFastPass({
      model: 'jev-1.14.0',
      ms: 110,
      usage: { inputTokens: 1, outputTokens: 0 },
      answers: {
        roll: { type: 'noul', p: 0.81 },
        resource: { type: 'noul', p: 0.2 },
        number: { type: 'noul', p: 0.5 },
        contradiction: { type: 'noul', p: 0.1 },
        story: { type: 'score', score: 2, probabilities: {} },
      },
    });
    expect(f.flagged).toEqual(['roll', 'number']);
    expect(f.story).toBe(7);
  });
});

describe('simulator', () => {
  it('a seed gives the same scenario and party every time', () => {
    expect(setupGame(42, 3)).toEqual(setupGame(42, 3));
    expect(setupGame(42, 3).personas).toHaveLength(3);
    expect(setupGame(1, 9).personas).toHaveLength(5);
  });

  it('applies the DM turn and reports spends the party cannot afford', () => {
    const party = Party.of([{ name: 'Esvahanna', cls: 'Cleric' }]);
    expect(applyTurn(party, { resources: [{ pc: 'Esvahanna', name: 'Channel Divinity' }], hp: [{ pc: 'Esvahanna', delta: -4 }], xp: 25 })).toEqual([]);
    expect(applyTurn(party, { resources: [{ pc: 'Esvahanna', name: 'Channel Divinity' }] })).toEqual(['Channel Divinity used while at 0/1']);
    expect(party.pc('Esvahanna')!.hp.current).toBe(20);
  });
});
