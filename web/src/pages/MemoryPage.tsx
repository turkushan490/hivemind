import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
            <FolderTree files={files} sel={sel} onOpen={open} />
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

interface TreeNode {
  name: string;
  full: string;
  file?: MemFile;
  dirs: Map<string, TreeNode>;
}

/** Build a nested folder tree from flat paths like "topics/food/potatoes.md". */
function buildTree(files: MemFile[]): TreeNode {
  const root: TreeNode = { name: '', full: '', dirs: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    parts.forEach((p, i) => {
      let child = cur.dirs.get(p);
      if (!child) {
        child = { name: p, full: parts.slice(0, i + 1).join('/'), dirs: new Map() };
        cur.dirs.set(p, child);
      }
      if (i === parts.length - 1) child.file = f;
      cur = child;
    });
  }
  return root;
}

/** Folders first, then files, each alphabetical. */
function sortedChildren(n: TreeNode): TreeNode[] {
  return [...n.dirs.values()].sort((a, b) => {
    const af = a.dirs.size > 0;
    const bf = b.dirs.size > 0;
    if (af !== bf) return af ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** The memory files as a tree of folders you can open and close, files shown by their short name. */
function FolderTree({ files, sel, onOpen }: { files: MemFile[]; sel?: string; onOpen: (p: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (p: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  const root = buildTree(files);
  const render = (node: TreeNode, depth: number): ReactNode[] =>
    sortedChildren(node).flatMap((child): ReactNode[] => {
      const pad = { paddingLeft: `${depth * 14 + 6}px` };
      if (child.dirs.size > 0) {
        const open = !collapsed.has(child.full);
        const count = countFiles(child);
        return [
          <button key={`d:${child.full}`} style={pad} className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm hover:bg-[#21262d]" onClick={() => toggle(child.full)}>
            <span className="w-3 text-xs text-slate-500">{open ? '▾' : '▸'}</span>
            <span className="truncate font-medium text-slate-200">{child.name}</span>
            <span className="ml-1 text-xs text-slate-600">{count}</span>
          </button>,
          ...(open ? render(child, depth + 1) : []),
        ];
      }
      const f = child.file!;
      return [
        <button
          key={`f:${child.full}`}
          style={pad}
          title={f.by ? `changed by ${f.by}` : undefined}
          className={`block w-full rounded px-1 py-1 text-left hover:bg-[#21262d] ${sel === f.path ? 'bg-[#21262d]' : ''}`}
          onClick={() => onOpen(f.path)}
        >
          <div className="flex items-center gap-1 text-sm">
            <span className="w-3" />
            <span className="truncate">{child.name.replace(/\.md$/, '')}</span>
          </div>
          {f.title && <div className="truncate pl-4 text-xs text-slate-500">{f.title}</div>}
        </button>,
      ];
    });
  return <>{render(root, 0)}</>;
}

/** How many files sit under a folder (for the little count badge). */
function countFiles(n: TreeNode): number {
  let c = n.file ? 1 : 0;
  for (const d of n.dirs.values()) c += countFiles(d);
  return c;
}
