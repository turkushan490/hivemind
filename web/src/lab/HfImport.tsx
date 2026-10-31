import type { Dataset, HfImportJob, HfImportMap, HfImportPreset, HfImportPreview } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

/**
 * Import a public Hugging Face dataset into the open text / chat dataset: paste a link, preview, map columns (or use
 * a preset), pick how many new examples, and watch it run. Importing again continues after the last imported example.
 */

const CAP = 1_000_000;
const FIREBALL = 'lara-martin/fireball';
const DM_DATASET = 'dungeonmind dm';
const n = (x: number) => x.toLocaleString('en');
type Field = keyof HfImportMap;
const FIELDS: [Field, string][] = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['system', 'System (optional)'],
];

const cell = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
};

export function HfImport({ dataset, onChanged }: { dataset: Dataset; onChanged: () => void }) {
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState<HfImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [preset, setPreset] = useState<HfImportPreset | ''>('');
  const [map, setMap] = useState<Required<HfImportMap>>({ input: [], output: [], system: [] });
  const [limit, setLimit] = useState('5000');
  const [all, setAll] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<HfImportJob | null>(null);

  const look = async () => {
    setLoading(true);
    try {
      const p = await api<HfImportPreview>(`/api/datasets/${dataset.id}/import/preview`, { body: { repo: link } });
      setPreview(p);
      setPreset(p.preset ?? '');
      const has = (c: string) => p.columns.includes(c);
      setMap({ input: ['question', 'prompt', 'instruction', 'input'].filter(has).slice(0, 1), output: ['answer', 'response', 'completion', 'output'].filter(has).slice(0, 1), system: [] });
      if (p.running) setJobId(p.running);
    } catch {
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  // The live counter: poll the job until it ends.
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await api<HfImportJob>(`/api/datasets/import/${jobId}`, { quiet: true });
        if (stop) return;
        setJob(j);
        onChanged();
        if (j.state === 'running') return void setTimeout(tick, 1000);
        setJobId(null);
        if (j.state === 'done') toast(j.capped ? `Imported ${n(j.done)} examples: the dataset is now full (${n(CAP)})` : `Imported ${n(j.done)} examples from ${j.repo}`, 'ok');
        if (j.state === 'failed') toast(`Import failed: ${j.error}`);
        setPreview((p) => p && { ...p, imported: p.imported + j.done, running: null });
      } catch {
        if (!stop) setJobId(null);
      }
    };
    tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const start = async () => {
    if (!preview) return;
    try {
      const body = { repo: preview.repo, ...(preset ? { preset } : { map }), limit: all ? null : Number(limit) };
      const r = await api<{ jobId: string }>(`/api/datasets/${dataset.id}/import`, { body });
      setJob(null);
      setJobId(r.jobId);
    } catch {}
  };
  const stopJob = async () => {
    if (jobId) await api(`/api/datasets/import/${jobId}`, { method: 'DELETE' }).catch(() => {});
  };

  const fireball = preview?.repo.toLowerCase() === FIREBALL;
  const running = !!jobId;
  const limitOk = all || (Number.isInteger(Number(limit)) && Number(limit) >= 1);
  const why = !dataset
    ? 'Open a dataset first'
    : !preview
      ? 'Preview first'
      : preview.needsToken
        ? 'Needs a Hugging Face token'
        : fireball && dataset.name.trim().toLowerCase() === DM_DATASET
          ? 'FIREBALL never goes into "DungeonMind DM"'
          : dataset.items + dataset.pending >= CAP
            ? `Dataset full (${n(CAP)} examples)`
            : !preset && (!map.input.length || !map.output.length)
              ? 'Pick Input and Output first'
              : !limitOk
                ? 'Give a number of examples'
                : null;

  return (
    <div className="space-y-2 rounded-md border border-[#30363d] p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-64 flex-1 py-1 text-xs"
          placeholder="https://huggingface.co/datasets/owner/name or owner/name"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && link.trim() && look()}
        />
        <button className="btn-ghost px-3 py-1 text-xs disabled:opacity-50" disabled={!link.trim() || loading} onClick={look}>
          {loading ? 'Looking…' : link.trim() ? 'Preview' : 'Preview (paste a link first)'}
        </button>
      </div>

      {preview && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <a className="font-semibold text-indigo-300 hover:text-indigo-200" href={`https://huggingface.co/datasets/${preview.repo}`} target="_blank" rel="noreferrer">
              {preview.repo}
            </a>
            <span className="text-slate-400">License: {preview.license ?? '—'}</span>
            {preview.rows !== null && <span className="text-slate-400">{n(preview.rows)} rows</span>}
            {preview.files !== null && <span className="text-slate-400">{n(preview.files)} files</span>}
            {preview.gated && <span className="text-amber-300">gated</span>}
          </div>
          {!preview.license && <p className="text-amber-300/90">No license listed. Check it before you publish a model trained on this.</p>}
          {preview.needsToken && <p className="text-amber-300/90">This dataset needs a Hugging Face token. Add one in Settings → Hugging Face.</p>}
          {fireball && (
            <ul className="list-disc space-y-0.5 rounded-md border border-amber-700/50 bg-amber-500/5 p-2 pl-6 text-amber-200/90">
              <li>FIREBALL gets a dataset of its own, never "DungeonMind DM": its answers are Avrae commands and Discord text, not the DM's JSON, and mixing them makes the DM's JSON worse.</li>
              <li>About two thirds of its turns have no story text, only commands such as <code>!cast armor of ag -l 2 -i</code>. A model trained on it learns to write those too.</li>
              <li>DungeonMind's nightly training only uses "DungeonMind DM". Train on FIREBALL by hand in Lab → New model.</li>
              <li>Use a limit for training: 153,829 turns is far too much for one run on a small GPU. Importing all of them is fine; check the time estimate before training.</li>
            </ul>
          )}

          {preview.sample.length > 0 && (
            <div className="max-h-56 overflow-auto rounded border border-[#30363d]">
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-[#161b22] text-slate-400">
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c} className="px-2 py-1 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((row, i) => (
                    <tr key={i} className="border-t border-[#30363d] align-top">
                      {preview.columns.map((c) => (
                        <td key={c} className="max-w-64 px-2 py-1 text-slate-300">
                          {c in row ? cell(row[c]) : ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!preview.needsToken && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">How the columns become examples:</span>
                <select className="input w-auto py-1 text-xs" value={preset} onChange={(e) => setPreset(e.target.value as HfImportPreset | '')}>
                  <option value="">My own mapping</option>
                  {fireball && <option value="fireball">FIREBALL preset (combat, chat → commands, results)</option>}
                  <option value="chat">Chat conversations (messages / conversations)</option>
                </select>
              </div>
              {!preset && (
                <div className="grid gap-2 md:grid-cols-3">
                  {FIELDS.map(([f, label]) => (
                    <div key={f} className="space-y-1">
                      <div className="text-slate-400">{label}</div>
                      <div className="flex flex-wrap gap-1">
                        {map[f].map((c) => (
                          <button key={c} className="rounded bg-indigo-500/20 px-1.5 py-0.5 hover:bg-red-500/20" title="Remove" onClick={() => setMap({ ...map, [f]: map[f].filter((x) => x !== c) })}>
                            {c} ✕
                          </button>
                        ))}
                      </div>
                      <select className="input py-1 text-xs" value="" onChange={(e) => e.target.value && setMap({ ...map, [f]: [...map[f], e.target.value] })}>
                        <option value="">+ column</option>
                        {preview.columns
                          .filter((c) => !map[f].includes(c))
                          .map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                      </select>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-400">New examples:</span>
                <input className="input w-24 py-1 text-xs disabled:opacity-50" type="number" min={1} value={limit} disabled={all} onChange={(e) => setLimit(e.target.value)} />
                <label className="flex items-center gap-1 text-slate-400">
                  <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All (up to {n(CAP)} in the dataset)
                </label>
                {running ? (
                  <button className="btn-ghost px-3 py-1 text-xs" onClick={stopJob}>
                    ■ Stop
                  </button>
                ) : (
                  <button className="btn px-3 py-1 text-xs disabled:opacity-50" disabled={!!why} onClick={start}>
                    {why ? `Import (${why})` : '⬇ Import'}
                  </button>
                )}
              </div>
              {preview.imported > 0 && <p className="text-slate-400">{n(preview.imported)} already imported, this continues with the next ones.</p>}
            </>
          )}
        </>
      )}

      {job && (
        <p className={job.state === 'failed' ? 'text-red-300' : job.state === 'running' ? 'text-indigo-200' : 'text-slate-300'}>
          {job.total !== null ? `${n(job.done)} / ${n(job.total)}` : `${n(job.done)} examples${job.file !== null ? ` · file ${n(job.file)} / ${n(job.files ?? 0)}` : ''}`}
          {job.skipped ? ` · ${n(job.skipped)} skipped` : ''}
          {job.state === 'stopped' && ' · stopped (what was imported stays; Import continues from there)'}
          {job.state === 'done' && (job.capped ? ` · done: the dataset is full (${n(CAP)} examples is the most it holds)` : ' · done')}
          {job.state === 'failed' && ` · failed: ${job.error}`}
        </p>
      )}
    </div>
  );
}
