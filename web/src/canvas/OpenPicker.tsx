import { groupByFolder, type Canvas } from '@hivemind/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStored } from '../stored';

interface ListProps {
  canvases: Canvas[];
  onOpen: (c: Canvas) => void;
  appName: (id: string) => string;
  /** The workflow open now (highlighted). */
  currentId?: string;
  autoFocus?: boolean;
}

/**
 * Your workflows grouped by folder (HiveBot, Websites, Software, Research, DungeonMind, Colibri, Other…), with a
 * search box. Folders fold open and shut (remembered); a search shows every match unfolded.
 */
export function WorkflowList({ canvases, onOpen, appName, currentId, autoFocus }: ListProps) {
  const [q, setQ] = useState('');
  const [closed, setClosed] = useStored<string[]>('canvas.closedFolders', []);
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hits = canvases.filter((c) => words.every((w) => `${c.name} ${c.folder ?? ''} ${c.description ?? ''}`.toLowerCase().includes(w)));
    return groupByFolder(hits);
  }, [canvases, q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input className="input m-2 w-auto py-1" autoFocus={autoFocus} placeholder="Search workflows…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {groups.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">Nothing matches.</p>}
        {groups.map((g) => {
          const shut = !q && closed.includes(g.folder);
          return (
            <div key={g.folder}>
              <button
                className="flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-xs font-semibold tracking-wide text-slate-400 uppercase hover:bg-[#21262d]"
                onClick={() => setClosed(shut ? closed.filter((f) => f !== g.folder) : [...closed, g.folder])}
              >
                <span className="w-3">{shut ? '▸' : '▾'}</span>
                <span className="min-w-0 flex-1 truncate">{g.folder}</span>
                <span className="font-normal text-slate-600">{g.items.length}</span>
              </button>
              {!shut &&
                g.items.map((c) => (
                  <button
                    key={c.id}
                    title={c.description || c.name}
                    className={`flex min-h-8 w-full items-center gap-2 rounded py-1 pr-2 pl-7 text-left text-sm hover:bg-[#21262d] ${
                      c.id === currentId ? 'bg-indigo-950/60 text-indigo-200' : 'text-slate-200'
                    }`}
                    onClick={() => onOpen(c)}
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
  );
}

/**
 * The workflow list as a panel on the left of the workflow screen (next to the blocks), opened and closed with
 * its edge button; the choice is remembered.
 */
export function WorkflowSidebar(props: Omit<ListProps, 'autoFocus'> & { onRefresh: () => void }) {
  const [open, setOpen] = useStored('canvas.listOpen', true);
  useEffect(() => {
    if (open) props.onRefresh();
    // Only when it opens: the list refreshes itself after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open)
    return (
      <button
        className="flex w-8 shrink-0 flex-col items-center gap-2 border-r border-[#30363d] bg-[#0d1117] pt-3 text-xs text-slate-400 hover:bg-[#161b22] hover:text-slate-200"
        onClick={() => setOpen(true)}
        title="Show your workflows"
      >
        <span>▸</span>
        <span className="[writing-mode:vertical-rl]">Workflows ({props.canvases.length})</span>
      </button>
    );
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[#30363d] bg-[#0d1117]">
      <div className="flex items-center gap-2 px-3 pt-3 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
        Workflows <span className="font-normal">{props.canvases.length}</span>
        <button className="btn-ghost ml-auto px-2 py-0.5 text-xs normal-case" onClick={() => setOpen(false)} title="Hide the list">
          ◂
        </button>
      </div>
      <WorkflowList {...props} />
    </aside>
  );
}

/** Open…: the same list as a dropdown (the phone, where there is no room for a side panel). */
export function OpenPicker({ canvases, onOpen, onRefresh, appName, currentId }: Omit<ListProps, 'autoFocus'> & { onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

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
        <div className="fixed inset-x-2 top-28 z-50 flex max-h-[70vh] flex-col rounded-lg border border-[#30363d] bg-[#161b22] shadow-xl md:absolute md:inset-x-auto md:top-auto md:mt-1 md:w-[26rem]">
          <WorkflowList
            canvases={canvases}
            appName={appName}
            currentId={currentId}
            autoFocus
            onOpen={(c) => {
              setOpen(false);
              onOpen(c);
            }}
          />
        </div>
      )}
    </div>
  );
}
