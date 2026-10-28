import type { ModelRef, RunEvent } from '@hivemind/shared';
import { newId } from '../crypto.js';
import { db } from '../db/index.js';
import { runGraph, withHostLock, type EngineDeps, type ResolvedProvider } from '../engine/run.js';
import { logError } from '../errors.js';
import { fill, labelled, type NodeInput, type NodeServices } from '../nodes/index.js';
import { FAST_PASS, JUDGE_SCHEMA, JUDGE_SYSTEM, parseVerdict, readFastPass, type ErrorType, type FastVerdict, type Verdict } from './judge.js';
import { applyTurn, DM_PROMPT, DM_SCHEMA, DM_SYSTEM, rng, rollFor, setupGame, simGraph, type DmTurn } from './sim.js';
import { Party } from './state.js';

/**
 * The batch runner: simulated games in the background until stopped by hand. Every model call takes the GPU
 * host lock and gives it back right after, so a real HiveMind or DungeonMind run waiting for the GPU goes next.
 */

export interface LabConfig {
  name?: string;
  /** DM model(s); with more than one, games take turns so every model plays the same seeded scenarios. */
  dm: ModelRef[];
  players: ModelRef;
  /** The full LLM rules-checker. */
  judge?: ModelRef;
  /** A decision model for the fast first pass (Jev nouls + story score). */
  jev?: ModelRef;
  partySize?: number;
  turnsPerGame?: number;
  /** Stop by itself after this many games / turns (otherwise: until Stop). */
  maxGames?: number;
  maxTurns?: number;
  seed?: number;
  /** Share of turns the LLM judge checks even when Jev finds nothing (default 0.1). */
  sample?: number;
  promptVersion?: string;
  /** Rules memory to look up for the judge (default rules:srd51; skipped when empty). */
  rulesKey?: string;
}

export interface LabStatus {
  id: string;
  name: string;
  running: boolean;
  games: number;
  turns: number;
  /** Turns with at least one error. */
  badTurns: number;
  errorsPer100: number;
  /** Turns per minute over the last 10 turns. */
  turnsPerMin?: number;
  failures: number;
  lastError?: string;
  startedAt: number;
  model?: string;
  state: 'running' | 'stopped' | 'done' | 'error';
}

export interface LabDeps {
  resolve: EngineDeps['resolve'];
  services?: NodeServices;
  record?: EngineDeps['record'];
}

const LOCAL_EXCLUSIVE = (p: ResolvedProvider) => p.local && p.exclusive !== false;
const label = (m: ModelRef) => `${m.providerId}|${m.model}`;

export class LabRun {
  readonly id = newId();
  stopped = false;
  private abort = new AbortController();
  private stamps: number[] = [];
  status: LabStatus;
  readonly done: Promise<void>;

  constructor(
    readonly ownerId: string,
    readonly cfg: LabConfig,
    private deps: LabDeps,
  ) {
    this.status = { id: this.id, name: cfg.name || 'DungeonMind sim', running: true, games: 0, turns: 0, badTurns: 0, errorsPer100: 0, failures: 0, startedAt: Date.now(), state: 'running' };
    db.prepare("INSERT INTO lab_runs (id, owner_id, name, config, status) VALUES (?, ?, ?, ?, 'running')").run(this.id, ownerId, this.status.name, JSON.stringify({ ...cfg, dmSystem: DM_SYSTEM }));
    this.done = this.loop().then(
      () => this.finish(this.status.state === 'running' ? 'stopped' : this.status.state),
      (err) => {
        this.fail(err as Error);
        this.finish('error');
      },
    );
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }

  private finish(state: LabStatus['state']) {
    this.status.state = state;
    this.status.running = false;
    db.prepare("UPDATE lab_runs SET status = ?, error = ?, stopped_at = datetime('now') WHERE id = ?").run(state, this.status.lastError ?? null, this.id);
  }

  private fail(err: Error) {
    this.status.failures++;
    this.status.lastError = err.message;
    logError({ source: 'server', message: `Lab: ${err.message}`, detail: err.stack, userId: this.ownerId });
  }

  private async loop() {
    const cfg = this.cfg;
    if (!cfg.dm?.length) throw new Error('Pick at least one DM model');
    const turnsPerGame = Math.max(1, Math.min(100, cfg.turnsPerGame ?? 8));
    let streak = 0;
    for (let g = 0; !this.stopped; g++) {
      if (cfg.maxGames && g >= cfg.maxGames) return this.end('done');
      const dm = cfg.dm[g % cfg.dm.length];
      // Every model gets the same scenarios, parties and dice: game g of each model shares one seed.
      const seed = (cfg.seed ?? 1) + Math.floor(g / cfg.dm.length);
      const { scenario, personas } = setupGame(seed, cfg.partySize ?? 3);
      const party = Party.of(personas);
      const dice = rng(seed * 7919 + 1);
      const recent: string[] = [];
      this.status.model = dm.model;
      for (let t = 0; t < turnsPerGame && !this.stopped; t++) {
        if (cfg.maxTurns && this.status.turns >= cfg.maxTurns) return this.end('done');
        try {
          await this.turn({ game: g, turn: t, seed, dm, scenario, personas, party, results: rollFor(dice, personas), recent });
          streak = 0;
        } catch (err) {
          if (this.stopped) return;
          this.fail(err as Error);
          // A broken model or provider should not spin forever: five failures in a row stop the run.
          if (++streak >= 5) throw new Error(`Stopped after 5 failed turns in a row: ${(err as Error).message}`);
        }
      }
      this.status.games++;
    }
  }

  private end(state: LabStatus['state']) {
    this.status.state = state;
    this.stopped = true;
  }

  private async turn(t: {
    game: number;
    turn: number;
    seed: number;
    dm: ModelRef;
    scenario: string;
    personas: ReturnType<typeof setupGame>['personas'];
    party: Party;
    results: string;
    recent: string[];
  }) {
    const before = t.party.describe();
    const vars = { scene: t.scenario, party: before, results: t.results, recent: t.recent.slice(-6).join('\n') || '(the game starts)' };
    const question = `${t.scenario}\n\nWhat happened so far:\n${vars.recent}`;
    const events: RunEvent[] = [];
    const graph = simGraph(t.personas, this.cfg.players, t.dm);
    const deps: EngineDeps = { resolve: this.deps.resolve, emit: (e) => events.push(e as RunEvent), services: this.deps.services, record: this.deps.record };
    const res = await runGraph(graph, question, deps, this.abort.signal, vars);
    if (this.stopped) return;
    const done = (id: string) => events.find((e) => e.type === 'node_done' && e.nodeId === id);
    const players: NodeInput[] = t.personas.flatMap((p) => {
      const ev = done(`p_${p.id}`);
      return ev?.text ? [{ nodeId: `p_${p.id}`, type: 'llm' as const, label: p.name, text: ev.text }] : [];
    });
    if (!players.length) throw new Error(`No player answered: ${events.find((e) => e.type === 'error')?.error ?? res.status}`);
    const input = fill(DM_PROMPT, { question, vars }, labelled(players));
    const dmDone = done('dm');
    const dmError = events.find((e) => e.type === 'error' && e.nodeId === 'dm')?.error;
    if (!dmDone && dmError && !/Invalid JSON/i.test(dmError)) throw new Error(`DM ${t.dm.model}: ${dmError}`);

    const errors = new Set<ErrorType>();
    let turn: DmTurn | undefined;
    if (dmDone?.text) {
      try {
        turn = JSON.parse(dmDone.text) as DmTurn;
      } catch {}
    }
    if (!turn) errors.add('json');
    const spendProblems = turn ? applyTurn(t.party, turn) : [];
    if (spendProblems.length) errors.add('resource');

    // What the checkers read: the party before the turn, the dice, recent turns, the actions and the DM's turn.
    const rules = await this.rules(players.map((p) => p.text).join(' '));
    const state = JSON.stringify({ party: before, dice_results: t.results, recent: vars.recent, actions: players.map((p) => `${p.label}: ${p.text}`), dm_turn: turn ?? dmDone?.text ?? dmError, ...(rules && { rules }) });

    let fast: FastVerdict | undefined;
    if (this.cfg.jev) fast = await this.fastPass(state);
    // The full judge: on what Jev flags, on what the bookkeeper caught, and on a random sample; on everything without Jev.
    const sample = rng(t.seed * 31 + t.game * 997 + t.turn)() < (this.cfg.sample ?? 0.1);
    let verdict: Verdict | undefined;
    if (this.cfg.judge && (!fast || fast.flagged.length || errors.size || sample)) verdict = await this.judge(state, spendProblems);
    for (const e of verdict?.errors ?? []) errors.add(e.type);
    if (!verdict) for (const f of fast?.flagged ?? []) errors.add(f);

    const errorTypes = [...errors];
    const output = dmDone?.text ?? `(${dmError ?? 'no answer'})`;
    db.prepare(
      `INSERT INTO lab_turns (run_id, game, turn, seed, model, prompt_version, input, output, json_valid, verdict, jev_verdict, error_types, story_score, jev_story, tokens_per_s, ms, corrected, review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.id,
      t.game,
      t.turn,
      t.seed,
      label(t.dm),
      this.cfg.promptVersion || 'v1',
      input,
      output,
      turn ? 1 : 0,
      verdict ? JSON.stringify({ ...verdict, ...(spendProblems.length && { bookkeeper: spendProblems }) }) : spendProblems.length ? JSON.stringify({ errors: [], bookkeeper: spendProblems }) : null,
      fast ? JSON.stringify(fast) : null,
      JSON.stringify(errorTypes),
      verdict?.story ?? null,
      fast?.story ?? null,
      dmDone?.tokensPerSec ?? null,
      dmDone?.elapsedMs ?? null,
      verdict?.corrected ?? null,
      // Bad turns go to the review queue (accept the correction, edit it, or reject the turn).
      errorTypes.length ? 'pending' : null,
    );
    if (turn?.narration) t.recent.push(`DM: ${turn.narration.slice(0, 400)}`);
    this.status.turns++;
    if (errorTypes.length) this.status.badTurns++;
    this.status.errorsPer100 = Math.round((this.status.badTurns / this.status.turns) * 1000) / 10;
    this.stamps = [...this.stamps.slice(-9), Date.now()];
    if (this.stamps.length > 1) this.status.turnsPerMin = Math.round(((this.stamps.length - 1) / ((this.stamps.at(-1)! - this.stamps[0]) / 60000)) * 10) / 10;
  }

  /** Rules the actions touch, from the rules memory (when it was imported). */
  private async rules(actions: string): Promise<string | undefined> {
    const key = this.cfg.rulesKey ?? 'rules:srd51';
    const search = this.deps.services?.memory?.search;
    if (!key || !search) return;
    try {
      const hits = search(key, actions, 4);
      return hits.length ? hits.map((h) => h.text).join('\n---\n').slice(0, 6000) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Jev nouls per error type and a story score; takes and gives back the GPU lock like any model call. */
  private async fastPass(state: string): Promise<FastVerdict> {
    const ref = this.cfg.jev!;
    const p = await this.deps.resolve(ref.providerId);
    if (!p.adapter.decide) throw new Error(`${ref.model} is not a decision model`);
    const ask = async () => {
      if (LOCAL_EXCLUSIVE(p)) await this.deps.services?.freeGpu?.(p.hostKey, ref.providerId).catch(() => {});
      return p.adapter.decide!({ model: ref.model, state, questions: FAST_PASS }, this.abort.signal);
    };
    const r = LOCAL_EXCLUSIVE(p) ? await withHostLock(p.hostKey, ask) : await ask();
    const info = await p.modelInfo(ref.model).catch(() => undefined);
    const { callCost } = await import('../services/pricing.js');
    try {
      this.deps.record?.usage({ nodeId: 'lab-jev', nodeType: 'decide', providerId: ref.providerId, model: ref.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cost: callCost(info, ref.model, r.usage.inputTokens, 0), genMs: r.ms });
    } catch {}
    return readFastPass(r);
  }

  /** The LLM rules-checker, as a one-block canvas (JSON mode, GPU lock, costs: all like a normal run). */
  private async judge(state: string, bookkeeper: string[]): Promise<Verdict> {
    const events: RunEvent[] = [];
    const graph = {
      nodes: [
        { id: 'q', type: 'input' as const, position: { x: 0, y: 0 }, config: {} },
        {
          id: 'judge',
          type: 'llm' as const,
          label: 'judge',
          position: { x: 300, y: 0 },
          config: {
            model: this.cfg.judge!,
            system: JUDGE_SYSTEM,
            prompt: `Check this turn:\n{{question}}${bookkeeper.length ? `\n\nThe bookkeeper already found: ${bookkeeper.join('; ')}` : ''}\n\nThe DM turn must follow this shape: ${DM_SCHEMA}`,
            json: true,
            jsonSchema: JUDGE_SCHEMA,
          },
        },
      ],
      edges: [{ id: 'e', source: 'q', target: 'judge' }],
    };
    await runGraph(graph, state, { resolve: this.deps.resolve, emit: (e) => events.push(e as RunEvent), services: this.deps.services, record: this.deps.record }, this.abort.signal);
    const out = events.find((e) => e.type === 'node_done' && e.nodeId === 'judge')?.text;
    if (!out) throw new Error(`Judge ${this.cfg.judge!.model}: ${events.find((e) => e.type === 'error')?.error ?? 'no verdict'}`);
    return parseVerdict(out);
  }
}

let active: LabRun | undefined;

export const activeLab = () => active;

export function startLab(ownerId: string, cfg: LabConfig, deps: LabDeps): LabRun {
  if (active?.status.running) throw new Error('A simulation is already running: stop it first');
  active = new LabRun(ownerId, cfg, deps);
  return active;
}

/** After a restart nothing is running any more. */
export function recoverLab() {
  db.prepare("UPDATE lab_runs SET status = 'stopped', stopped_at = COALESCE(stopped_at, datetime('now')) WHERE status = 'running'").run();
}
