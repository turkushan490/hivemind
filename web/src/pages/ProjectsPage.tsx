import type { BuildResult, GitStatus, Project, ProjectChange, ProjectFile } from '@hivemind/shared';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';
import { ChangeRow } from '../components/PausePanel';
import { projectNames } from '../canvas/meta';
import { useStored } from '../stored';

const SUBS = { files: 'Files', preview: 'Preview', history: 'History', github: 'GitHub', build: 'Build' } as const;
type Sub = keyof typeof SUBS;

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Uploads a raw body (a file or a zip): fetch directly, the api() helper only sends JSON. */
async function upload(url: string, body: Blob, type: string) {
  const res = await fetch(url, { method: url.endsWith('/zip') || url.includes('/zip?') ? 'POST' : 'PUT', headers: { 'content-type': type }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * Projects: folders of files that stay between runs (a website). Edit files, preview the site, see what each run
 * changed, connect GitHub, and build with npm.
 */
export function ProjectsPage({ active }: { active: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useStored<string>('projects.selected', '');
  const [name, setName] = useState('');
  const load = () =>
    api<Project[]>('/api/projects', { quiet: true })
      .then((ps) => {
        ps.forEach((x) => projectNames.set(x.id, x.name));
        setProjects(ps);
      })
      .catch(() => {});
  useEffect(() => {
    if (active) load();
  }, [active]);
  const project = projects.find((p) => p.id === selected);

  const create = async () => {
    if (!name.trim()) return;
    try {
      const p = await api<Project>('/api/projects', { body: { name } });
      setName('');
      await load();
      setSelected(p.id);
    } catch {}
  };

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <aside className="space-y-2 md:w-60 md:shrink-0">
        <div className="flex gap-1">
          <input className="input py-1 text-sm" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className="btn shrink-0 px-2 py-1 text-sm" onClick={create}>
            Add
          </button>
        </div>
        {projects.length === 0 && <p className="text-sm text-slate-400">No projects yet. A project is a folder of files (a website) that workflows read, write, build and push.</p>}
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelected(p.id)}
            className={`block w-full rounded-md px-3 py-2 text-left text-sm ${p.id === selected ? 'bg-[#21262d] text-white' : 'text-slate-300 hover:bg-[#161b22]'}`}
          >
            <div className="truncate font-medium">{p.name}</div>
            <div className="text-xs text-slate-500">
              {p.outside && <span className="text-sky-400">{p.outside} · </span>}
              {p.files} files · {size(p.sizeBytes)}
              {p.githubRepo && ` · ${p.githubRepo}`}
              {p.owner && ` · ${p.owner}`}
            </div>
          </button>
        ))}
        <OtherApps
          projects={projects}
          onOpened={async (id) => {
            await load();
            setSelected(id);
          }}
        />
      </aside>
      <div className="min-w-0 flex-1">{project ? <ProjectView key={project.id} project={project} onChanged={load} onDeleted={() => (setSelected(''), load())} /> : <p className="text-sm text-slate-400">Pick or add a project.</p>}</div>
    </div>
  );
}

function ProjectView({ project, onChanged, onDeleted }: { project: Project; onChanged: () => void; onDeleted: () => void }) {
  const [sub, setSub] = useStored<Sub>('projects.sub', 'files');
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [previewUrl, setPreviewUrl] = useState('');
  const loadTree = async () => {
    try {
      const t = await api<{ files: ProjectFile[]; folders: string[]; previewUrl: string }>(`/api/projects/${project.id}/tree`, { quiet: true });
      setFiles(t.files);
      setFolders(t.folders);
      setPreviewUrl(t.previewUrl);
    } catch {}
  };
  useEffect(() => {
    loadTree();
  }, [project.id, project.updatedAt]);

  const rename = async () => {
    const n = prompt('New name', project.name);
    if (!n?.trim()) return;
    await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { name: n } }).catch(() => {});
    onChanged();
  };
  const remove = async () => {
    if (!confirm(`Delete the project "${project.name}" and all its files? GitHub is not touched.`)) return;
    await api(`/api/projects/${project.id}`, { method: 'DELETE' }).catch(() => {});
    onDeleted();
  };
  const uploadZip = (f: File) =>
    upload(`/api/projects/${project.id}/zip`, f, 'application/zip')
      .then((r: { added: number; refused: string[] }) => {
        toast(`${r.added} files added${r.refused.length ? `, ${r.refused.length} refused` : ''}`, r.refused.length ? undefined : 'ok');
        loadTree();
        onChanged();
      })
      .catch((e: Error) => toast(e.message));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{project.name}</h2>
        {project.githubRepo && (
          <a className="text-xs text-sky-400 hover:underline" href={`https://github.com/${project.githubRepo}`} target="_blank" rel="noreferrer noopener">
            {project.githubRepo} ({project.githubBranch})
          </a>
        )}
        <span className="ml-auto" />
        <label className="btn-ghost cursor-pointer text-xs">
          Upload .zip
          <input type="file" accept=".zip" hidden onChange={(e) => e.target.files?.[0] && uploadZip(e.target.files[0])} />
        </label>
        <a className="btn-ghost text-xs" href={`/api/projects/${project.id}/zip`}>
          Download .zip
        </a>
        <button className="btn-ghost text-xs" onClick={rename}>
          Rename
        </button>
        <button className="btn-ghost text-xs text-red-300" onClick={remove}>
          Delete
        </button>
      </div>
      <nav className="flex gap-1 border-b border-[#30363d]">
        {(Object.keys(SUBS) as Sub[]).map((s) => (
          <button key={s} onClick={() => setSub(s)} className={`px-3 py-1.5 text-sm ${sub === s ? 'border-b-2 border-indigo-400 text-white' : 'text-slate-400 hover:text-white'}`}>
            {SUBS[s]}
          </button>
        ))}
      </nav>
      {sub === 'files' && <FilesTab project={project} files={files} folders={folders} reload={() => (loadTree(), onChanged())} />}
      {sub === 'preview' && <PreviewTab files={files} previewUrl={previewUrl} reload={loadTree} />}
      {sub === 'history' && <HistoryTab project={project} />}
      {sub === 'github' && <GithubTab project={project} onChanged={() => (loadTree(), onChanged())} />}
      {sub === 'build' && <BuildTab project={project} hasPackage={files.some((f) => f.path === 'package.json')} onBuilt={() => (loadTree(), onChanged())} />}
    </div>
  );
}

function FilesTab({ project, files, folders, reload }: { project: Project; files: ProjectFile[]; folders: string[]; reload: () => void }) {
  const [open, setOpen] = useState<string>();
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [filter, setFilter] = useState('');
  const base = `/api/projects/${project.id}`;
  const enc = encodeURIComponent;

  const openFile = async (f: ProjectFile) => {
    if (open && text !== saved && !confirm('Leave without saving?')) return;
    if (!f.text) {
      window.open(`${base}/file?path=${enc(f.path)}&raw=1`, '_blank');
      return;
    }
    try {
      const r = await api<{ text: string }>(`${base}/file?path=${enc(f.path)}`);
      setOpen(f.path);
      setText(r.text);
      setSaved(r.text);
    } catch {}
  };
  const save = async () => {
    if (!open) return;
    try {
      await api(`${base}/file?path=${enc(open)}`, { method: 'PUT', body: { text } });
      setSaved(text);
      toast('Saved', 'ok');
      reload();
    } catch {}
  };
  const newFile = async () => {
    const path = prompt('New file (path in the project)', 'index.html');
    if (!path) return;
    try {
      await api(`${base}/file?path=${enc(path)}`, { method: 'PUT', body: { text: '' } });
      reload();
      setOpen(path);
      setText('');
      setSaved('');
    } catch {}
  };
  const newFolder = async () => {
    const path = prompt('New folder', 'pages');
    if (path) await api(`${base}/folder`, { body: { path } }).then(reload, () => {});
  };
  const move = async (from: string) => {
    const to = prompt('Move or rename to', from);
    if (to && to !== from) await api(`${base}/move`, { body: { from, to } }).then(() => (open === from && setOpen(to), reload()), () => {});
  };
  const remove = async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return;
    await api(`${base}/file?path=${enc(path)}`, { method: 'DELETE' }).then(() => (open === path && setOpen(undefined), reload()), () => {});
  };
  const uploadFiles = async (list: FileList) => {
    const folder = prompt('Upload into which folder? (empty: the top)', '') ?? '';
    for (const f of Array.from(list)) {
      const path = `${folder.replace(/^\/+|\/+$/g, '')}${folder ? '/' : ''}${f.name}`;
      try {
        await upload(`${base}/file?path=${enc(path)}`, f, 'application/octet-stream');
      } catch (e) {
        toast(`${path}: ${(e as Error).message}`);
      }
    }
    reload();
  };

  const shown = useMemo(() => files.filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase())), [files, filter]);
  const emptyFolders = folders.filter((d) => !files.some((f) => f.path.startsWith(`${d}/`)));
  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <div className="space-y-2 lg:w-80 lg:shrink-0">
        <div className="flex flex-wrap gap-1">
          <button className="btn-ghost text-xs" onClick={newFile}>
            New file
          </button>
          <button className="btn-ghost text-xs" onClick={newFolder}>
            New folder
          </button>
          <label className="btn-ghost cursor-pointer text-xs">
            Upload files
            <input type="file" multiple hidden onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
          </label>
        </div>
        <input className="input py-1 text-xs" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="max-h-[65vh] overflow-auto rounded border border-[#30363d]">
          {shown.length === 0 && emptyFolders.length === 0 && <p className="p-2 text-xs text-slate-500">No files yet.</p>}
          {shown.map((f) => {
            const depth = f.path.split('/').length - 1;
            return (
              <div key={f.path} className={`group flex items-center gap-1 px-2 py-0.5 text-xs ${open === f.path ? 'bg-[#21262d]' : 'hover:bg-[#161b22]'}`} style={{ paddingLeft: 8 + depth * 12 }}>
                <button className="min-w-0 flex-1 truncate text-left font-mono text-slate-200" title={f.path} onClick={() => openFile(f)}>
                  {depth ? <span className="text-slate-500">{f.path.split('/').slice(0, -1).join('/')}/</span> : null}
                  {f.path.split('/').pop()}
                </button>
                <span className="shrink-0 text-slate-500">{size(f.size)}</span>
                <button className="hidden text-slate-400 hover:text-white group-hover:inline" onClick={() => move(f.path)} title="Move or rename">
                  ✎
                </button>
                <button className="hidden text-red-400 group-hover:inline" onClick={() => remove(f.path)} title="Delete">
                  ✕
                </button>
              </div>
            );
          })}
          {emptyFolders.map((d) => (
            <div key={d} className="group flex items-center gap-1 px-2 py-0.5 text-xs text-slate-500">
              <span className="flex-1 font-mono">{d}/ (empty)</span>
              <button className="hidden text-red-400 group-hover:inline" onClick={() => remove(d)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {open ? (
          <>
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-sm">{open}</span>
              {text !== saved && <span className="text-xs text-amber-300">not saved</span>}
              <button className="btn ml-auto px-3 py-1 text-sm" disabled={text === saved} onClick={save}>
                Save
              </button>
            </div>
            <textarea
              className="input min-h-[60vh] font-mono text-xs leading-5"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                  e.preventDefault();
                  save();
                }
              }}
            />
          </>
        ) : (
          <p className="text-sm text-slate-400">Pick a file to edit it. Workflows change files with the Write files block; each change shows under History.</p>
        )}
      </div>
    </div>
  );
}

function PreviewTab({ files, previewUrl, reload }: { files: ProjectFile[]; previewUrl: string; reload: () => void }) {
  const pages = files.filter((f) => /\.html?$/i.test(f.path)).map((f) => f.path);
  const start = ['index.html', 'dist/index.html', 'build/index.html'].find((p) => pages.includes(p)) ?? pages[0] ?? '';
  const [page, setPage] = useState(start);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!pages.includes(page)) setPage(start);
  }, [files]);
  if (!pages.length) return <p className="text-sm text-slate-400">No HTML pages yet.</p>;
  const url = `${previewUrl}${page}`;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input w-auto py-1 text-xs" value={page} onChange={(e) => setPage(e.target.value)}>
          {pages.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <button className="btn-ghost text-xs" onClick={() => (reload(), setN((x) => x + 1))}>
          Reload
        </button>
        <a className="text-xs text-sky-400 hover:underline" href={url} target="_blank" rel="noreferrer noopener">
          Open in a new tab ↗
        </a>
        <span className="text-xs text-slate-500">Runs sandboxed: the page can't use your HiveMind login.</span>
      </div>
      <iframe key={`${url}-${n}`} title="Preview" src={url} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="h-[70vh] w-full rounded border border-[#30363d] bg-white" />
    </div>
  );
}

function HistoryTab({ project }: { project: Project }) {
  const [h, setH] = useState<{ changes: ProjectChange[]; commits: { sha: string; message: string; at: string; author: string }[] }>();
  useEffect(() => {
    api(`/api/projects/${project.id}/history`, { quiet: true }).then(setH).catch(() => {});
  }, [project.id, project.updatedAt]);
  if (!h) return <p className="text-sm text-slate-400">Loading…</p>;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-2">
        {h.changes.length === 0 && <p className="text-sm text-slate-400">No changes yet.</p>}
        {h.changes.map((c) => (
          <div key={c.id} className="card space-y-1">
            <div className="text-xs text-slate-400">
              {new Date(`${c.at.replace(' ', 'T')}Z`).toLocaleString()} · {c.source}
              {c.runId && <span className="ml-1 font-mono text-slate-500">run {c.runId}</span>}
            </div>
            {c.changes.map((x) => (
              <ChangeRow key={x.path} c={x} />
            ))}
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Commits</h3>
        {h.commits.length === 0 && <p className="text-xs text-slate-500">Not connected to GitHub, or nothing committed yet.</p>}
        {h.commits.map((c) => (
          <div key={c.sha} className="text-xs">
            <span className="font-mono text-slate-500">{c.sha.slice(0, 7)}</span> {c.message}
            <div className="text-slate-500">
              {c.author} · {new Date(c.at).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GithubTab({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [status, setStatus] = useState<GitStatus>();
  const [repos, setRepos] = useState<{ fullName: string; private: boolean; defaultBranch: string }[]>();
  const [repo, setRepo] = useState('');
  const [newName, setNewName] = useState(project.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
  const [branch, setBranch] = useState('main');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const base = `/api/projects/${project.id}`;
  const load = () => api<GitStatus>(`${base}/git`, { quiet: true }).then(setStatus).catch(() => {});
  useEffect(() => {
    load();
  }, [project.id, project.updatedAt]);
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
      await load();
      onChanged();
    } catch {
      // api() shows the error.
    } finally {
      setBusy('');
    }
  };

  if (!status) return <p className="text-sm text-slate-400">Loading…</p>;
  if (!status.connected)
    return (
      <div className="max-w-xl space-y-3">
        <p className="text-sm text-slate-300">
          Connect this project to a GitHub repo. It uses your token from <b>Settings → GitHub</b>. An empty project gets the repo's files; a project with files starts a branch that is still empty on
          GitHub.
        </p>
        <div className="card space-y-2">
          <div className="text-sm font-semibold">An existing repo</div>
          {repos ? (
            <select className="input text-sm" value={repo} onChange={(e) => (setRepo(e.target.value), setBranch(repos.find((r) => r.fullName === e.target.value)?.defaultBranch ?? 'main'))}>
              <option value="">Pick a repo…</option>
              {repos.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                  {r.private ? ' (private)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <button className="btn-ghost text-sm" onClick={() => api(`/api/github/repos`).then(setRepos, () => {})}>
              Load my repos
            </button>
          )}
          <input className="input text-sm" placeholder="or type owner/name" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <input className="input text-sm" placeholder="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} />
          <button className="btn text-sm" disabled={!repo || !!busy} onClick={() => run('connect', () => api(`${base}/git/connect`, { body: { repo, branch } }))}>
            {busy === 'connect' ? 'Connecting…' : 'Connect'}
          </button>
        </div>
        <div className="card space-y-2">
          <div className="text-sm font-semibold">A new private repo</div>
          <input className="input text-sm" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn text-sm" disabled={!newName || !!busy} onClick={() => run('create', () => api(`${base}/git/connect`, { body: { repo: newName, branch: 'main', create: true } }))}>
            {busy === 'create' ? 'Making it…' : 'Make the repo and connect'}
          </button>
          <p className="text-xs text-slate-500">Needs the token right "Administration: read and write" (to make repos).</p>
        </div>
      </div>
    );
  return (
    <div className="max-w-2xl space-y-3">
      <div className="card space-y-1 text-sm">
        <div>
          <a className="text-sky-400 hover:underline" href={`https://github.com/${status.repo}`} target="_blank" rel="noreferrer noopener">
            {status.repo}
          </a>{' '}
          on <b>{status.branch}</b>
        </div>
        <div className="text-xs text-slate-400">
          {status.changes.length} uncommitted change{status.changes.length === 1 ? '' : 's'} · {status.ahead} commit{status.ahead === 1 ? '' : 's'} not on GitHub yet
        </div>
        {status.lastCommit && (
          <div className="text-xs text-slate-500">
            Last: <span className="font-mono">{status.lastCommit.sha.slice(0, 7)}</span> {status.lastCommit.message}
          </div>
        )}
        {status.changes.length > 0 && <pre className="max-h-32 overflow-auto rounded bg-[#0d1117] p-2 font-mono text-[11px] text-slate-400">{status.changes.join('\n')}</pre>}
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="input max-w-sm flex-1 py-1 text-sm" placeholder="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button className="btn px-3 py-1 text-sm" disabled={!!busy || !status.changes.length} onClick={() => run('commit', () => api(`${base}/git/commit`, { body: { message } }).then(() => setMessage('')))}>
          Commit
        </button>
        <button className="btn px-3 py-1 text-sm" disabled={!!busy} onClick={() => run('push', () => api(`${base}/git/push`, { method: 'POST' }).then(() => toast('Pushed', 'ok')))}>
          {busy === 'push' ? 'Pushing…' : 'Push'}
        </button>
        <button className="btn-ghost px-3 py-1 text-sm" disabled={!!busy} onClick={() => run('pull', () => api(`${base}/git/pull`, { method: 'POST' }).then(() => toast('Pulled', 'ok')))}>
          {busy === 'pull' ? 'Pulling…' : 'Pull'}
        </button>
        <button
          className="btn-ghost px-3 py-1 text-sm"
          disabled={!!busy}
          onClick={() =>
            run('pr', () =>
              api<{ url: string }>(`${base}/git/pr`, { body: { title: message || 'Changes from HiveMind' } }).then((r) => {
                toast('Pull request made', 'ok');
                window.open(r.url, '_blank', 'noopener');
              }),
            )
          }
        >
          Pull request
        </button>
        <button className="btn-ghost ml-auto px-3 py-1 text-sm text-red-300" disabled={!!busy} onClick={() => confirm('Disconnect? The files stay; the git history in this project is removed (GitHub keeps everything).') && run('disconnect', () => api(`${base}/git/disconnect`, { method: 'POST' }))}>
          Disconnect
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Push never forces: when GitHub has newer commits, Pull first (your commits go on top of GitHub's). After a pull request the project shows its own branch again; Pull once the request is merged.
      </p>
    </div>
  );
}

function BuildTab({ project, hasPackage, onBuilt }: { project: Project; hasPackage: boolean; onBuilt: () => void }) {
  const [script, setScript] = useState('build');
  const [result, setResult] = useState<BuildResult>();
  const [busy, setBusy] = useState(false);
  const build = async () => {
    setBusy(true);
    try {
      const r = await api<BuildResult>(`/api/projects/${project.id}/build`, { body: { script } });
      setResult(r);
      if (r.ok) onBuilt();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-3xl space-y-3">
      {!hasPackage && <p className="text-sm text-slate-400">This project has no package.json: a plain HTML site needs no build. Projects with React, Vite and the like build here.</p>}
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-300">npm run</span>
        <input className="input w-40 py-1 font-mono text-sm" value={script} onChange={(e) => setScript(e.target.value)} />
        <button className="btn px-3 py-1 text-sm" disabled={busy || !hasPackage} onClick={build}>
          {busy ? 'Building…' : 'Build'}
        </button>
      </div>
      <p className="text-xs text-slate-500">Runs npm install and the script inside HiveMind, on a copy of the project, without HiveMind's keys, for at most 10 minutes. The output folder (dist/) is copied into the project.</p>
      {result && (
        <div className={`card space-y-1 ${result.ok ? 'border-emerald-800' : 'border-red-800'}`}>
          <div className="text-sm">
            {result.ok ? `Built in ${Math.round(result.ms / 1000)} s → ${result.outDir}/` : 'The build failed'}
          </div>
          <pre className="max-h-96 overflow-auto rounded bg-[#0d1117] p-2 font-mono text-[11px] text-slate-300">{result.log}</pre>
        </div>
      )}
    </div>
  );
}

interface Outside {
  enabled: boolean;
  roots: string[];
  list: { root: string; mounted: boolean; folders: { name: string; path: string; git: boolean }[] }[];
}

/**
 * Folders of other apps (admins): e.g. T3 Code's projects, mounted into the HiveMind container as /projects. Switched
 * on, each folder there can be opened as a project in place, so workflows read and change the same files.
 */
function OtherApps({ projects, onOpened }: { projects: Project[]; onOpened: (id: string) => void }) {
  const [o, setO] = useState<Outside | null>(null);
  const [roots, setRoots] = useState('');
  useEffect(() => {
    api<Outside>('/api/outside-folders', { quiet: true })
      .then((x) => {
        setO(x);
        setRoots(x.roots.join(', '));
      })
      .catch(() => setO(null));
  }, []);
  if (!o) return null;
  const save = async (patch: Partial<Outside>) => {
    try {
      const x = await api<Outside>('/api/outside-folders', { method: 'PUT', body: patch });
      setO(x);
      setRoots(x.roots.join(', '));
    } catch {}
  };
  const opened = new Map(projects.filter((p) => p.outside).map((p) => [p.outside!, p.id]));
  return (
    <details className="mt-4 rounded-md border border-[#30363d] p-2 text-sm" open={o.enabled}>
      <summary className="cursor-pointer text-slate-300">Folders of other apps</summary>
      <p className="mt-1 text-xs text-slate-500">
        Folders of other apps (like T3 Code) mounted into HiveMind in its Docker template. Switched on, you can open them here as projects: workflows then read and change the same files. Deleting such a
        project only removes it from HiveMind; the folder stays.
      </p>
      <label className="mt-2 flex items-center gap-2 text-xs">
        <input type="checkbox" checked={o.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        Allow HiveMind to work in these folders
      </label>
      <div className="mt-2 flex gap-1">
        <input className="input py-1 text-xs" value={roots} onChange={(e) => setRoots(e.target.value)} placeholder="/projects" title="Folders inside the HiveMind container, comma separated" />
        <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => save({ roots: roots.split(/[,\s]+/).filter(Boolean) })}>
          Save
        </button>
      </div>
      {o.list.map((r) => (
        <div key={r.root} className="mt-2 space-y-1">
          <div className="text-xs font-semibold text-slate-400">{r.root}</div>
          {!r.mounted && <p className="text-xs text-amber-300">Not mounted: add it as a path in HiveMind&apos;s Docker template (Unraid: Edit → Add another Path).</p>}
          {r.mounted && r.folders.length === 0 && <p className="text-xs text-slate-500">No folders in it yet.</p>}
          {r.folders.map((f) => (
            <div key={f.path} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={f.path}>
                {f.name}
                {f.git && <span className="ml-1 text-slate-500">git</span>}
              </span>
              {opened.has(f.path) ? (
                <button className="btn-ghost px-2 py-0.5" onClick={() => onOpened(opened.get(f.path)!)}>
                  Show
                </button>
              ) : (
                <button
                  className="btn-ghost px-2 py-0.5"
                  disabled={!o.enabled}
                  onClick={async () => {
                    try {
                      const p = await api<Project>('/api/projects/outside', { body: { path: f.path } });
                      toast(`${p.name} is now a project`, 'ok');
                      onOpened(p.id);
                    } catch {}
                  }}
                >
                  Open as project
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </details>
  );
}
