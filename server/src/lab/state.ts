/**
 * The Lab's mini bookkeeper: HP, spell slots, counters (Channel Divinity, Action Surge…), conditions and XP of
 * the fake party, so the rules-checker has ground truth. Replaced by DungeonMind's real Bookkeeper API later (M13).
 * D&D only on purpose.
 */

export type Recharge = 'short' | 'long' | 'none';

export interface Counter {
  current: number;
  max: number;
  recharge: Recharge;
}

export interface PcState {
  name: string;
  cls: string;
  hp: { current: number; max: number };
  /** Spell slots per level ("1", "2", …). */
  slots: Record<string, { current: number; max: number }>;
  counters: Record<string, Counter>;
  conditions: string[];
  xp: number;
}

export interface SpendResult {
  ok: boolean;
  /** Why the spend is wrong, e.g. "Channel Divinity used while at 0/1". */
  error?: string;
}

const counter = (max: number, recharge: Recharge): Counter => ({ current: max, max, recharge });
const slots = (...max: number[]) => Object.fromEntries(max.map((m, i) => [String(i + 1), { current: m, max: m }]));

/** The classes the fake players play (level 3), one per persona. */
export const CLASSES: Record<string, () => Omit<PcState, 'name'>> = {
  Fighter: () => ({ cls: 'Fighter', hp: { current: 31, max: 31 }, slots: {}, counters: { 'Action Surge': counter(1, 'short'), 'Second Wind': counter(1, 'short') }, conditions: [], xp: 900 }),
  Wizard: () => ({ cls: 'Wizard', hp: { current: 17, max: 17 }, slots: slots(4, 2), counters: { 'Arcane Recovery': counter(1, 'long') }, conditions: [], xp: 900 }),
  Rogue: () => ({ cls: 'Rogue', hp: { current: 24, max: 24 }, slots: {}, counters: {}, conditions: [], xp: 900 }),
  Cleric: () => ({ cls: 'Cleric', hp: { current: 24, max: 24 }, slots: slots(4, 2), counters: { 'Channel Divinity': counter(1, 'short') }, conditions: [], xp: 900 }),
  Bard: () => ({ cls: 'Bard', hp: { current: 21, max: 21 }, slots: slots(4, 2), counters: { 'Bardic Inspiration': counter(3, 'long') }, conditions: [], xp: 900 }),
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class Party {
  pcs: PcState[];

  constructor(pcs: PcState[]) {
    this.pcs = pcs;
  }

  static of(members: { name: string; cls: string }[]): Party {
    return new Party(members.map((m) => ({ name: m.name, ...(CLASSES[m.cls] ?? CLASSES.Fighter)() })));
  }

  pc(name: string): PcState | undefined {
    return this.pcs.find((p) => norm(p.name) === norm(name)) ?? this.pcs.find((p) => norm(p.name).split(' ')[0] === norm(name).split(' ')[0]);
  }

  /**
   * Spends a resource: a counter by name ("Channel Divinity"), or a spell slot ("slot 2", "level 1 slot", "spell slot").
   * Never goes below 0: spending what isn't there is the error the checker looks for.
   */
  spend(pcName: string, resource: string, amount = 1): SpendResult {
    const pc = this.pc(pcName);
    if (!pc) return { ok: false, error: `${pcName} is not in the party` };
    const n = Math.max(1, Math.floor(amount) || 1);
    const r = norm(resource);
    const slotLevel = r.match(/(?:level\s*)?(\d)(?:st|nd|rd|th)?(?:\s*level)?\s*(?:spell\s*)?slot|slot\s*(?:level\s*)?(\d)/);
    if (slotLevel || /slot/.test(r)) {
      const lvl = slotLevel?.[1] ?? slotLevel?.[2] ?? Object.keys(pc.slots).find((k) => pc.slots[k].current > 0) ?? '1';
      const s = pc.slots[lvl];
      if (!s) return { ok: false, error: `${pc.name} has no level ${lvl} spell slots` };
      if (s.current < n) return { ok: false, error: `${pc.name} used a level ${lvl} slot while at ${s.current}/${s.max}` };
      s.current -= n;
      return { ok: true };
    }
    const key = Object.keys(pc.counters).find((k) => norm(k) === r) ?? Object.keys(pc.counters).find((k) => r.includes(norm(k)) || norm(k).includes(r));
    if (!key) return { ok: false, error: `${pc.name} has no "${resource}"` };
    const c = pc.counters[key];
    if (c.current < n) return { ok: false, error: `${key} used while at ${c.current}/${c.max}` };
    c.current -= n;
    return { ok: true };
  }

  /** Damage (negative) or healing (positive), kept between 0 and max HP; 0 HP adds "unconscious". */
  hp(pcName: string, delta: number): SpendResult {
    const pc = this.pc(pcName);
    if (!pc) return { ok: false, error: `${pcName} is not in the party` };
    pc.hp.current = Math.max(0, Math.min(pc.hp.max, pc.hp.current + Math.round(delta)));
    if (pc.hp.current === 0 && !pc.conditions.includes('unconscious')) pc.conditions.push('unconscious');
    if (pc.hp.current > 0) pc.conditions = pc.conditions.filter((c) => c !== 'unconscious');
    return { ok: true };
  }

  condition(pcName: string, cond: string, on: boolean) {
    const pc = this.pc(pcName);
    if (!pc) return;
    const c = cond.toLowerCase().trim();
    pc.conditions = on ? [...new Set([...pc.conditions, c])] : pc.conditions.filter((x) => x !== c);
  }

  xp(amount: number) {
    for (const pc of this.pcs) pc.xp += Math.max(0, Math.round(amount));
  }

  /** Short rest: short-recharge counters back to max. Long rest: everything, HP and slots too. */
  rest(kind: 'short' | 'long') {
    for (const pc of this.pcs) {
      for (const c of Object.values(pc.counters)) if (kind === 'long' || c.recharge === 'short') c.current = c.max;
      if (kind === 'long') {
        for (const s of Object.values(pc.slots)) s.current = s.max;
        pc.hp.current = pc.hp.max;
        pc.conditions = [];
      }
    }
  }

  snapshot(): PcState[] {
    return JSON.parse(JSON.stringify(this.pcs));
  }

  /** "Brakka (Fighter) HP 31/31 · Action Surge 1/1 · Second Wind 1/1" per line, for prompts. */
  describe(): string {
    return this.pcs
      .map((p) => {
        const parts = [`HP ${p.hp.current}/${p.hp.max}`];
        for (const [lvl, s] of Object.entries(p.slots)) parts.push(`level ${lvl} slots ${s.current}/${s.max}`);
        for (const [k, c] of Object.entries(p.counters)) parts.push(`${k} ${c.current}/${c.max}`);
        if (p.conditions.length) parts.push(`conditions: ${p.conditions.join(', ')}`);
        return `${p.name} (${p.cls}) ${parts.join(' · ')}`;
      })
      .join('\n');
  }
}
