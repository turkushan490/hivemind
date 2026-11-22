import type { LoadedModel, ProviderMemory } from '@hivemind/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/** Where a loaded model is: "1.2 GB RAM", "4.6 GB GPU" or "6.9 GB: 0.6 GB GPU + 6.3 GB RAM". */
function where(m: LoadedModel): string {
  if (!m.vramBytes) return `${gb(m.sizeBytes)} RAM`;
  if (m.vramBytes >= m.sizeBytes * 0.98) return `${gb(m.sizeBytes)} GPU`;
  return `${gb(m.sizeBytes)}: ${gb(m.vramBytes)} GPU + ${gb(m.sizeBytes - m.vramBytes)} RAM`;
}

/** "unloads in 3 min", "kept warm" or nothing. */
function until(m: LoadedModel): string {
  if (m.keptWarm) {
    const last = m.keptWarm.lastAt ? `, last ${new Date(m.keptWarm.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    return m.keptWarm.reloads ? `kept warm (reloaded ${m.keptWarm.reloads}× today${last})` : 'kept warm';
  }
  if (!m.expiresAt) return '';
  const ms = Date.parse(m.expiresAt) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms > 7 * 86_400_000) return 'stays loaded';
  if (ms > 2 * 3_600_000) return `unloads in ${Math.round(ms / 3_600_000)} h`;
  return `unloads in ${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** Header button: what Ollama holds in RAM/VRAM, and a way to clear it. */
export function MemoryButton() {
  const [open, setOpen] = useState(false);
  const [mem, setMem] = useState<ProviderMemory[]>([]);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = async () => setMem(await api<ProviderMemory[]>('/api/memory', { quiet: true }).catch(() => []));

  useEffect(() => {
    load();
    const t = setInterval(load, open ? 3000 : 15000);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const total = mem.reduce((s, p) => s + p.models.reduce((a, m) => a + m.sizeBytes, 0), 0);
  const count = mem.reduce((s, p) => s + p.models.length, 0);
  const onGpu = mem.reduce((s, p) => s + p.models.reduce((a, m) => a + m.vramBytes, 0), 0);

  const inUse = mem.some((p) => p.models.some((m) => m.runs?.length));

  const unload = async (providerId?: string, model?: string) => {
    setBusy(true);
    try {
      const r = await api<{ unloaded: string[]; failed: { model: string; error: string }[]; stoppedRuns?: number }>('/api/memory/unload', { body: { providerId, model } });
      const stopped = r.stoppedRuns ?? 0;
      const runs = `${stopped} run${stopped === 1 ? '' : 's'}`;
      const models = `${r.unloaded.length} model${r.unloaded.length === 1 ? '' : 's'}`;
      if (stopped && r.unloaded.length) toast(`Stopped ${runs} and unloaded ${models}`, 'ok');
      else if (r.unloaded.length) toast(`Unloaded ${models} from memory`, 'ok');
      else if (stopped) toast(`Stopped ${runs}`, 'ok');
      else if (!r.failed.length) toast('Nothing was loaded', 'info');
      for (const f of r.failed) toast(`Could not unload ${f.model}: ${f.error}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={box}>
      <button className="btn-ghost flex items-center gap-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`h-2 w-2 rounded-full ${count ? 'bg-amber-400' : 'bg-slate-600'}`} />
        {count ? `${count} loaded · ${gb(total)}${onGpu ? ` · GPU ${gb(onGpu)}` : ''}` : 'Memory free'}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-96 space-y-3 rounded-lg border border-[#30363d] bg-[#161b22] p-3 shadow-xl">
          <div className="flex items-center">
            <h3 className="font-semibold">Loaded models</h3>
            <button className="btn ml-auto bg-red-600 hover:bg-red-500" disabled={busy || count === 0} onClick={() => unload()}>
              {busy ? 'Unloading…' : inUse ? 'Stop & unload all' : 'Unload all'}
            </button>
          </div>
          {mem.length === 0 && <p className="text-sm text-slate-400">No local providers.</p>}
          {mem.map((p) => (
            <div key={p.providerId} className="space-y-1 border-t border-[#30363d] pt-2 text-sm">
              <div className="text-xs text-slate-400" title={p.usedBy?.join(', ')}>
                {p.name}
                {p.usedBy && <span className="text-slate-500"> — used by: {p.usedBy.join(', ')}</span>}
              </div>
              {p.error && <p className="text-xs text-red-400">{p.error}</p>}
              {!p.error && p.models.length === 0 && <p className="text-xs text-slate-500">Nothing loaded — RAM and VRAM are free.</p>}
              {p.models.map((m) => (
                <div key={m.model}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={m.model}>
                      {m.model}
                    </span>
                    {m.vramBytes > 0 && m.vramBytes < m.sizeBytes * 0.98 && (
                      <span className="text-amber-400" title="Split between the GPU and RAM: slow, and it can fail when the GPU fills up">
                        ⚠
                      </span>
                    )}
                    {p.canUnload && (
                      <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy} onClick={() => unload(p.providerId, m.model)}>
                        {m.runs?.length ? 'Stop & unload' : 'Unload'}
                      </button>
                    )}
                  </div>
                  <div className={`ml-3 text-xs ${m.keptWarm?.error ? 'text-red-400' : 'text-slate-400'}`} title={m.keptWarm?.error}>
                    {where(m)}
                    {until(m) && <span className="text-slate-500"> · {until(m)}</span>}
                  </div>
                  {m.runs?.map((r) => (
                    <div key={r.runId} className="ml-3 truncate text-xs text-slate-400" title={r.runId}>
                      {r.state === 'running' ? '▶ in use by' : '… waiting:'} {r.canvasName ?? 'a run'}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
