import { groupByFolder, type Canvas } from '@hivemind/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStored } from '../stored';

/**
 * Open…: your workflows grouped by folder (HiveBot, Websites, Software, Research, DungeonMind, Colibri, Other…),
 * with a search box. Folders fold open and shut; a search shows every match unfolded.
 */
export function OpenPicker({ canvases, onOpen, onRefresh, appName }: { canvases: Canvas[]; onOpen: (c: Canvas) => void; onRefresh: () => void; appName: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useStored<string[]>('canvas.closedFolders', []);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = canvases.filter((c) => words.every((w) => `${c.name} ${c.folder ?? ''} ${c.description ?? ''}`.toLowerCase().includes(w)));
    return groupByFolder(hits);
  }, [canvases, q]);

  return (
    <div className="relative" ref={box}>
      <button
        className="input w-auto py-1 text-left"
        onClick={() => {
          if (!open) onRefresh();
          setOpen((o) => !o);
        }}
      >
        Open… ({canvases.length}) ▾
      </button>
      {open && (
        <div className="fixed inset-x-2 top-28 z-50 flex max-h-[70vh] flex-col rounded-lg md:absolute md:inset-x-auto md:top-auto md:mt-1 md:w-[26rem] border border-[#30363d] bg-[#161b22] shadow-xl">
          <input className="input m-2 w-auto" autoFocus placeholder="Search workflows…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {groups.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">Nothing matches.</p>}
            {groups.map((g) => {
              const shut = !q && closed.includes(g.folder);
              return (
                <div key={g.folder}>
                  <button
                    className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-xs font-semibold tracking-wide text-slate-400 uppercase hover:bg-[#21262d]"
                    onClick={() => setClosed(shut ? closed.filter((f) => f !== g.folder) : [...closed, g.folder])}
                  >
                    <span className="w-3">{shut ? '▸' : '▾'}</span>
                    {g.folder}
                    <span className="font-normal text-slate-600">{g.items.length}</span>
                  </button>
                  {!shut &&
                    g.items.map((c) => (
                      <button
                        key={c.id}
                        className="flex min-h-9 w-full items-center gap-2 rounded py-1 pr-2 pl-7 text-left text-sm text-slate-200 hover:bg-[#21262d]"
                        onClick={() => {
                          setOpen(false);
                          onOpen(c);
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        {c.shared && <span className="text-xs text-slate-500">shared</span>}
                        {c.managedBy && <span className="text-xs text-sky-400">{appName(c.managedBy)}</span>}
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
