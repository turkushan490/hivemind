import type { CanvasGraph, ModelRef } from '@hivemind/shared';
import type { Party } from './state.js';

/**
 * The dnd-sim canvas: fake players (llm blocks with personas) act, the AI DM answers with narration and
 * bookkeeping as JSON. Built in code for each turn; the engine runs it, so GPU locks, costs and errors work as
 * for every other run.
 */

export interface Persona {
  id: string;
  name: string;
  cls: string;
  prompt: string;
}

export const PERSONAS: Persona[] = [
  { id: 'reckless', name: 'Brakka', cls: 'Fighter', prompt: 'You are Brakka, a reckless half-orc fighter. You charge in first, love Action Surge and never retreat.' },
  {
    id: 'lawyer',
    name: 'Quill',
    cls: 'Wizard',
    prompt: 'You are Quill, a rules-lawyer wizard. You quote rules, and you try to cast spells even when your spell slots are used up, insisting you still have one.',
  },
  { id: 'rogue', name: 'Vex', cls: 'Rogue', prompt: 'You are Vex, a sneaky rogue. You hide, steal, scout and stab from the shadows.' },
  { id: 'healer', name: 'Esvahanna', cls: 'Cleric', prompt: 'You are Esvahanna, a cleric. You heal the wounded, use Channel Divinity and protect the weak.' },
  {
    id: 'casual',
    name: 'Turks',
    cls: 'Bard',
    prompt: 'You are Turks, a casual player of a bard. You write short, sloppy, typo-heavy messages, sometimes half in Dutch ("ik cast fierbolt op die gast").',
  },
];

export const SCENARIOS = [
  'A rain-soaked crossroads at dusk. A hag in a crow-feather cloak blocks the bridge and demands a name.',
  'A collapsed crypt beneath a chapel. Three ghouls scratch at the sealed door you just came through.',
  'A smugglers’ cove at low tide. The cultists are loading something that moves inside a cage.',
  'A burning mill. A child is trapped upstairs and a hulking ogre guards the stairs.',
  'A frozen lake at night. Something huge circles beneath the ice; the ice is cracking.',
  'A noble’s masked ball. One guest is a doppelgänger who has already replaced the host.',
];

export const DM_SYSTEM =
  'You are the Dungeon Master of a dark-fantasy D&D 5e game. The numbers are always the server’s: use the given dice results exactly, ask for rolls instead of deciding uncertain outcomes, ' +
  'never change HP, spell slots or other numbers beyond what the dice and rules allow, and list every limited resource a character spends. A character can’t spend a resource the party state shows at 0.';

export const DM_SCHEMA =
  '{"narration":"what happens, vivid but short","rolls":[{"pc":"name","kind":"attack|save|skill|damage","stat":"","dc":0}],"resources":[{"pc":"name","name":"Channel Divinity | level 1 slot | …","amount":1}],"hp":[{"pc":"name","delta":-5}],"conditions":[{"pc":"name","name":"prone","on":true}],"xp":0}';

export const DM_PROMPT =
  'Scene:\n{{vars.scene}}\n\nParty state:\n{{vars.party}}\n\nDice results from the server:\n{{vars.results}}\n\nRecent turns:\n{{vars.recent}}\n\nWhat the players do:\n\n{{inputs}}\n\nRun this turn.';

/** Small seeded PRNG (mulberry32), so a seed gives the same scenarios, parties and dice on every model. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const die = (r: () => number, sides: number) => 1 + Math.floor(r() * sides);

/** One game: its scenario and fake party, picked from the seed. */
export function setupGame(seed: number, size: number): { scenario: string; personas: Persona[] } {
  const r = rng(seed);
  const scenario = SCENARIOS[Math.floor(r() * SCENARIOS.length)];
  const pool = [...PERSONAS];
  const personas: Persona[] = [];
  const n = Math.max(2, Math.min(5, size));
  while (personas.length < n) personas.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return { scenario, personas };
}

/** The server's dice for this turn, one line per character. */
export function rollFor(r: () => number, personas: Persona[]): string {
  return personas.map((p) => `${p.name}: d20=${die(r, 20)}, second d20=${die(r, 20)}, damage d8=${die(r, 8)}, d6=${die(r, 6)}`).join('\n');
}

export function simGraph(personas: Persona[], players: ModelRef, dm: ModelRef): CanvasGraph {
  const q = { id: 'scene', type: 'input' as const, label: 'Scene', position: { x: 0, y: 200 }, config: {} };
  const ps = personas.map((p, i) => ({
    id: `p_${p.id}`,
    type: 'llm' as const,
    label: p.name,
    position: { x: 320, y: i * 150 },
    config: {
      model: players,
      system: `${p.prompt} You play ${p.name} the ${p.cls} in a D&D game. Stay in character.`,
      prompt: '{{question}}\n\nYour state:\n{{vars.party}}\n\nSay what you do this turn in one or two sentences, in character. No dice, no numbers.',
      temperature: 0.9,
    },
  }));
  const dmNode = { id: 'dm', type: 'llm' as const, label: 'dm', position: { x: 680, y: 200 }, config: { model: dm, system: DM_SYSTEM, prompt: DM_PROMPT, json: true, jsonSchema: DM_SCHEMA, numCtx: 16384 } };
  const out = { id: 'out', type: 'output' as const, label: 'Final answer', position: { x: 1000, y: 200 }, config: {} };
  return {
    nodes: [q, ...ps, dmNode, out],
    edges: [...ps.map((p) => ({ id: `scene->${p.id}`, source: 'scene', target: p.id })), ...ps.map((p) => ({ id: `${p.id}->dm`, source: p.id, target: 'dm' })), { id: 'dm->out', source: 'dm', target: 'out' }],
  };
}

export interface DmTurn {
  narration?: string;
  rolls?: { pc?: string; kind?: string }[];
  resources?: { pc?: string; name?: string; amount?: number }[];
  hp?: { pc?: string; delta?: number }[];
  conditions?: { pc?: string; name?: string; on?: boolean }[];
  xp?: number;
}

/** Applies the DM's bookkeeping to the party; every spend the party can't afford is a resource error. */
export function applyTurn(party: Party, t: DmTurn): string[] {
  const problems: string[] = [];
  for (const r of t.resources ?? []) {
    if (!r?.pc || !r.name) continue;
    const res = party.spend(r.pc, r.name, r.amount ?? 1);
    if (!res.ok && res.error) problems.push(res.error);
  }
  for (const h of t.hp ?? []) if (h?.pc && typeof h.delta === 'number') party.hp(h.pc, h.delta);
  for (const c of t.conditions ?? []) if (c?.pc && c.name) party.condition(c.pc, c.name, c.on !== false);
  if (typeof t.xp === 'number') party.xp(t.xp);
  return problems;
}
