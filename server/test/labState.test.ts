import { describe, expect, it } from 'vitest';
import { Party } from '../src/lab/state.js';

const party = () =>
  Party.of([
    { name: 'Brakka', cls: 'Fighter' },
    { name: 'Esvahanna', cls: 'Cleric' },
    { name: 'Turks', cls: 'Bard' },
  ]);

describe('Lab bookkeeper', () => {
  it('counts a counter down and refuses to go below 0', () => {
    const p = party();
    expect(p.spend('Esvahanna', 'Channel Divinity')).toEqual({ ok: true });
    expect(p.pc('Esvahanna')!.counters['Channel Divinity'].current).toBe(0);
    expect(p.spend('Esvahanna', 'channel divinity')).toEqual({ ok: false, error: 'Channel Divinity used while at 0/1' });
    expect(p.pc('Esvahanna')!.counters['Channel Divinity'].current).toBe(0);
  });

  it('spends spell slots per level and multi-use counters by amount', () => {
    const p = party();
    expect(p.spend('Turks', 'level 2 slot').ok).toBe(true);
    expect(p.spend('Turks', '2nd level spell slot').ok).toBe(true);
    expect(p.spend('Turks', 'slot 2')).toEqual({ ok: false, error: 'Turks used a level 2 slot while at 0/2' });
    expect(p.spend('Turks', 'Bardic Inspiration', 2).ok).toBe(true);
    expect(p.spend('Turks', 'Bardic Inspiration', 2)).toEqual({ ok: false, error: 'Bardic Inspiration used 2× while at 1/3' });
    expect(p.spend('Brakka', 'spell slot')).toEqual({ ok: false, error: 'Brakka has no level 1 spell slots' });
    expect(p.spend('Nobody', 'x').ok).toBe(false);
  });

  it('keeps HP between 0 and max, with unconscious at 0', () => {
    const p = party();
    p.hp('Brakka', -40);
    expect(p.pc('Brakka')!.hp.current).toBe(0);
    expect(p.pc('Brakka')!.conditions).toContain('unconscious');
    p.hp('Brakka', 100);
    expect(p.pc('Brakka')!.hp).toEqual({ current: 31, max: 31 });
    expect(p.pc('Brakka')!.conditions).not.toContain('unconscious');
  });

  it('short rest recharges short counters, long rest everything', () => {
    const p = party();
    p.spend('Brakka', 'Action Surge');
    p.spend('Turks', 'Bardic Inspiration');
    p.spend('Turks', 'slot 1');
    p.rest('short');
    expect(p.pc('Brakka')!.counters['Action Surge'].current).toBe(1);
    expect(p.pc('Turks')!.counters['Bardic Inspiration'].current).toBe(2);
    p.rest('long');
    expect(p.pc('Turks')!.counters['Bardic Inspiration'].current).toBe(3);
    expect(p.pc('Turks')!.slots['1'].current).toBe(4);
  });

  it('describes the party for prompts and adds XP to everyone', () => {
    const p = party();
    p.xp(50);
    expect(p.pc('Turks')!.xp).toBe(950);
    expect(p.describe()).toContain('Esvahanna (Cleric) HP 24/24 · level 1 slots 4/4 · level 2 slots 2/2 · Channel Divinity 1/1');
  });
});
