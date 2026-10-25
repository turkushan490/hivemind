import type { ProviderMemory } from '@hivemind/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

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

  const unload = async (providerId?: string, model?: string) => {
    setBusy(true);
    try {
      const r = await api<{ unloaded: string[]; failed: { model: string; error: string }[] }>('/api/memory/unload', { body: { providerId, model } });
      if (r.unloaded.length) toast(`Unloaded ${r.unloaded.length} model${r.unloaded.length > 1 ? 's' : ''} from memory`, 'ok');
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
        {count ? `${count} loaded · ${gb(total)}` : 'Memory free'}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-96 space-y-3 rounded-lg border border-[#30363d] bg-[#161b22] p-3 shadow-xl">
          <div className="flex items-center">
            <h3 className="font-semibold">Loaded models</h3>
            <button className="btn ml-auto bg-red-600 hover:bg-red-500" disabled={busy || count === 0} onClick={() => unload()}>
              {busy ? 'Unloading…' : 'Unload all'}
            </button>
          </div>
          {mem.length === 0 && <p className="text-sm text-slate-400">No local providers.</p>}
          {mem.map((p) => (
            <div key={p.providerId} className="space-y-1 border-t border-[#30363d] pt-2 text-sm">
              <div className="text-xs text-slate-400">{p.name}</div>
              {p.error && <p className="text-xs text-red-400">{p.error}</p>}
              {!p.error && p.models.length === 0 && <p className="text-xs text-slate-500">Nothing loaded — RAM and VRAM are free.</p>}
              {p.models.map((m) => (
                <div key={m.model} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={m.model}>
                    {m.model}
                  </span>
                  <span className="text-xs whitespace-nowrap text-slate-400">
                    {gb(m.sizeBytes)}
                    {m.vramBytes > 0 && m.vramBytes < m.sizeBytes ? ` (${gb(m.vramBytes)} GPU)` : m.vramBytes ? ' GPU' : ' RAM'}
                  </span>
                  {p.canUnload && (
                    <button className="btn-ghost px-2 py-0.5 text-xs" disabled={busy} onClick={() => unload(p.providerId, m.model)}>
                      Unload
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
