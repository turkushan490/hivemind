import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

interface MemFile {
  path: string;
  size: number;
  at?: string;
  by?: string;
  title?: string;
}
interface Version {
  id: string;
  at: string;
  by?: string;
}

/**
 * Settings → Memory (H11): the robot's / owner's memory as a tree of Markdown files — view, edit, search, restore a
 * version. A "Guest" switch shows the separate guest memory (used when the robot is locked).
 */
export function MemoryPage({ active }: { active: boolean }) {
  const [files, setFiles] = useState<MemFile[]>([]);
  const [guest, setGuest] = useState(false);
  const [sel, setSel] = useState<string>();
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ path: string; snippet: string }[] | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);

  const g = guest ? '?guest=1' : '';
  const loadTree = useCallback(() => api<{ files: MemFile[] }>(`/api/memory-files/tree${g}`, { quiet: true }).then((r) => setFiles(r.files)).catch(() => setFiles([])), [g]);
  useEffect(() => {
    if (active) loadTree();
  }, [active, loadTree]);

  const open = async (path: string) => {
    if (dirty && !confirm('Discard your unsaved changes?')) return;
    const r = await api<{ files: { path: string; content?: string }[] }>(`/api/memory-files/read`, { body: { paths: [path], guest }, quiet: true }).catch(() => null);
    setSel(path);
    setText(r?.files[0]?.content ?? '');
    setDirty(false);
    api<{ versions: Version[] }>(`/api/memory-files/versions?path=${encodeURIComponent(path)}${guest ? '&guest=1' : ''}`, { quiet: true }).then((v) => setVersions(v.versions)).catch(() => setVersions([]));
  };
  const save = async () => {
    if (!sel) return;
    await api(`/api/memory-files`, { method: 'PUT', body: { path: sel, text, guest } }).catch(() => {});
    setDirty(false);
    toast('Saved', 'ok');
    loadTree();
    api<{ versions: Version[] }>(`/api/memory-files/versions?path=${encodeURIComponent(sel)}${guest ? '&guest=1' : ''}`, { quiet: true }).then((v) => setVersions(v.versions)).catch(() => {});
  };
  const del = async () => {
    if (!sel || !confirm(`Move ${sel} to archive/deleted?`)) return;
    await api(`/api/memory-files`, { method: 'DELETE', body: { path: sel, guest } }).catch(() => {});
    setSel(undefined);
    setText('');
    setDirty(false);
    loadTree();
  };
  const restore = async (id: string) => {
    if (!sel || !confirm('Restore this version? The current text is kept as a version too.')) return;
    const r = await api<{ content?: never }>(`/api/memory-files/restore`, { body: { path: sel, id, guest } }).catch(() => null);
    if (r) open(sel);
  };
  const newFile = async () => {
    const path = prompt('New file path, e.g. topics/food/potatoes.md');
    if (!path) return;
    await api(`/api/memory-files`, { method: 'PUT', body: { path, text: `# ${path.split('/').pop()?.replace(/\.md$/, '')}\n`, guest } }).catch(() => {});
    await loadTree();
    open(path);
  };
  const runSearch = async () => {
    if (!q.trim()) return setResults(null);
    const r = await api<{ results: { path: string; snippet: string }[] }>(`/api/memory-files/search?q=${encodeURIComponent(q)}${guest ? '&guest=1' : ''}`, { quiet: true }).catch(() => ({ results: [] }));
    setResults(r.results);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Memory</h2>
        <span className="text-sm text-slate-400">The characters&apos; memory as Markdown files. Edit anything; every save keeps versions.</span>
        <label className="ml-auto flex items-center gap-1.5 text-sm text-slate-300">
          <input type="checkbox" checked={guest} onChange={(e) => { setGuest(e.target.checked); setSel(undefined); setText(''); setDirty(false); }} /> Guest memory
        </label>
        <button className="btn-ghost text-sm" onClick={newFile}>New file</button>
      </div>
      <div className="flex gap-1">
        <input className="input" placeholder="Search memory…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
        <button className="btn" onClick={runSearch}>Search</button>
        {results && <button className="btn-ghost" onClick={() => { setResults(null); setQ(''); }}>Clear</button>}
      </div>

      <div className="grid gap-3 md:grid-cols-[18rem_1fr]">
        <div className="card max-h-[70vh] space-y-0.5 overflow-auto p-2">
          {results ? (
            results.length === 0 ? (
              <p className="p-2 text-sm text-slate-500">No matches.</p>
            ) : (
              results.map((r) => (
                <button key={r.path} className="block w-full rounded px-2 py-1 text-left hover:bg-[#21262d]" onClick={() => open(r.path)}>
                  <div className="truncate text-sm">{r.path}</div>
                  <div className="truncate text-xs text-slate-500">{r.snippet}</div>
                </button>
              ))
            )
          ) : files.length === 0 ? (
            <p className="p-2 text-sm text-slate-500">No memory files yet.</p>
          ) : (
            files.map((f) => (
              <button
                key={f.path}
                className={`block w-full rounded px-2 py-1 text-left hover:bg-[#21262d] ${sel === f.path ? 'bg-[#21262d]' : ''}`}
                title={f.by ? `changed by ${f.by}` : undefined}
                onClick={() => open(f.path)}
              >
                <div className="truncate text-sm">{f.path}</div>
                {f.title && <div className="truncate text-xs text-slate-500">{f.title}</div>}
              </button>
            ))
          )}
        </div>

        <div className="card space-y-2">
          {sel ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{sel}</span>
                <span className="ml-auto flex gap-1">
                  <button className="btn" disabled={!dirty} onClick={save}>Save</button>
                  <button className="btn-ghost text-red-300" onClick={del}>Delete</button>
                </span>
              </div>
              <textarea
                className="input min-h-[55vh] w-full font-mono text-sm"
                value={text}
                onChange={(e) => { setText(e.target.value); setDirty(true); }}
              />
              {versions.length > 0 && (
                <div className="text-xs text-slate-400">
                  <span className="mr-1">Versions:</span>
                  {versions.map((v) => (
                    <button key={v.id} className="mr-1 rounded bg-[#21262d] px-1.5 py-0.5 hover:text-white" title={`${v.by ?? ''} ${v.at}`} onClick={() => restore(v.id)}>
                      {v.at.slice(0, 16).replace('T', ' ')}{v.by ? ` · ${v.by}` : ''}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="p-4 text-sm text-slate-500">Pick a file on the left, or make a new one.</p>
          )}
        </div>
      </div>
    </div>
  );
}
