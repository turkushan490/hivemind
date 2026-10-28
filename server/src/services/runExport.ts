import type { RunEvent } from '@hivemind/shared';
import { db } from '../db/index.js';

/** One finished run as a readable report: the question, the answer, and what every block did. */
export interface RunReport {
  hivemind: 1;
  type: 'run-report';
  id: string;
  question: string;
  canvas?: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  cost?: number;
  final?: string;
  blocks: {
    id: string;
    type: string;
    label: string;
    model?: string;
    status: 'done' | 'error' | 'skipped';
    text?: string;
    error?: string;
    inputTokens?: number;
    outputTokens?: number;
    tokensPerSec?: number;
    cost?: number;
    seconds?: number;
    files?: string[];
  }[];
  winners: { by: string; winner: string; from: string[] }[];
}

export function runReport(ownerId: string, id: string): RunReport | undefined {
  const r = db
    .prepare(`SELECT r.*, c.name AS canvas_name FROM runs r LEFT JOIN canvases c ON c.id = r.canvas_id WHERE r.id = ? AND r.owner_id = ? AND r.status != 'running'`)
    .get(id, ownerId) as Record<string, any> | undefined;
  if (!r) return;
  const events = JSON.parse(r.events ?? '[]') as RunEvent[];
  const graph = events.find((e) => e.type === 'run_start')?.graph;
  const label = (nodeId?: string) => {
    const n = graph?.nodes.find((x) => x.id === nodeId);
    return n?.label || n?.config.model?.model || n?.type || nodeId || 'block';
  };
  const blocks: RunReport['blocks'] = [];
  for (const e of events) {
    if (!e.nodeId || e.nodeType === 'input') continue;
    const base = { id: e.nodeId, type: e.nodeType ?? 'block', label: label(e.nodeId), model: e.model };
    if (e.type === 'node_done')
      blocks.push({
        ...base,
        status: 'done',
        text: e.text,
        inputTokens: e.inputTokens,
        outputTokens: e.tokens,
        tokensPerSec: e.tokensPerSec ? Math.round(e.tokensPerSec * 10) / 10 : undefined,
        cost: e.cost,
        seconds: e.elapsedMs ? Math.round(e.elapsedMs / 100) / 10 : undefined,
        files: e.files?.map((f) => f.path),
      });
    else if (e.type === 'error' && e.error !== 'All inputs failed') blocks.push({ ...base, status: 'error', error: e.error });
    else if (e.type === 'node_skipped') blocks.push({ ...base, status: 'skipped' });
  }
  const winners = (db.prepare('SELECT node_id, winner_label, contenders FROM run_winners WHERE run_id = ?').all(id) as Record<string, string>[]).map((w) => ({
    by: label(w.node_id),
    winner: w.winner_label,
    from: JSON.parse(w.contenders) as string[],
  }));
  return {
    hivemind: 1,
    type: 'run-report',
    id: r.id,
    question: r.question,
    canvas: r.canvas_name ?? undefined,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? undefined,
    cost: r.cost ?? undefined,
    final: r.final ?? undefined,
    blocks,
    winners,
  };
}

/** hm-file: links point into the files folder; in a document they need the server address. */
const decoded = (p: string) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};
const files = (md: string, base: string) => md.replace(/\(hm-file:([^)\s]+)\)/g, (_, p: string) => `(${base}/api/files/raw?inline=1&path=${encodeURIComponent(decoded(p))})`);

export function runMarkdown(r: RunReport, base = ''): string {
  const facts = [
    r.canvas && `**Canvas:** ${r.canvas}`,
    `**Status:** ${r.status}`,
    `**Started:** ${r.startedAt} UTC`,
    r.cost !== undefined && `**Cost:** $${r.cost.toFixed(4)}`,
  ].filter(Boolean);
  const out = [`# ${r.question.replace(/\n+/g, ' ')}`, '', facts.join('  \n'), '', '## Answer', '', r.final ? files(r.final, base) : '_No final answer._', ''];
  if (r.winners.length) {
    out.push('## Best answer picked', '');
    for (const w of r.winners) out.push(`- ${w.by} picked **${w.winner}** (from ${w.from.join(', ')})`);
    out.push('');
  }
  out.push('## How it was made', '');
  // The Final answer block only repeats the answer above.
  for (const b of r.blocks.filter((x) => x.type !== 'output')) {
    const stats = [
      b.model,
      b.outputTokens !== undefined && `${b.outputTokens} tokens out`,
      b.inputTokens && `${b.inputTokens} in`,
      b.tokensPerSec && `${b.tokensPerSec} tok/s`,
      b.seconds !== undefined && `${b.seconds} s`,
      b.cost !== undefined && `$${b.cost.toFixed(4)}`,
    ].filter(Boolean);
    out.push(`### ${b.label}${b.status !== 'done' ? ` — ${b.status}` : ''}`, '');
    if (stats.length) out.push(`_${stats.join(' · ')}_`, '');
    if (b.error) out.push(`> Error: ${b.error}`, '');
    if (b.text) out.push(files(b.text, base), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
