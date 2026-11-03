import type { GithubSettings, Skill } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

/** Settings → GitHub: your token (never shown again) and who commits. */
export function GithubPanel({ active }: { active: boolean }) {
  const [s, setS] = useState<GithubSettings>();
  const [token, setToken] = useState('');
  const [author, setAuthor] = useState({ name: '', email: '' });
  const load = () =>
    api<GithubSettings>('/api/settings/github', { quiet: true })
      .then((x) => {
        setS(x);
        setAuthor({ name: x.authorName ?? '', email: x.authorEmail ?? '' });
      })
      .catch(() => {});
  useEffect(() => {
    if (active) load();
  }, [active]);
  const save = async (body: Record<string, string>) => {
    try {
      setS(await api<GithubSettings>('/api/settings/github', { method: 'PUT', body }));
      setToken('');
      toast('Saved', 'ok');
    } catch {}
  };
  return (
    <div className="max-w-2xl space-y-4">
      <div className="card space-y-2">
        <h2 className="font-semibold">GitHub</h2>
        <p className="text-sm text-slate-300">
          Your own token lets projects push to your repos (Projects → GitHub, and the Git block). It is stored encrypted and never shown again; workflows can't read it.
        </p>
        <p className="text-xs text-slate-400">
          Make a <b>fine-grained token</b> on GitHub (Settings → Developer settings → Fine-grained tokens) for the repos you want, with <b>Contents: read and write</b> (and Pull requests: read and
          write for pull requests). Add <b>Administration: read and write</b> only if HiveMind should make new repos.
        </p>
        {s?.hasToken ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              Token <span className="font-mono">…{s.last4}</span>
              {s.login && (
                <>
                  {' '}
                  of <b>{s.login}</b>
                </>
              )}
            </span>
            <button className="btn-ghost text-xs" onClick={() => api<{ login?: string }>('/api/settings/github/test', { method: 'POST' }).then((r) => toast(`Works: ${r.login ?? 'ok'}`, 'ok'), () => {})}>
              Test
            </button>
            <button className="btn-ghost text-xs text-red-300" onClick={() => confirm('Remove your GitHub token?') && api('/api/settings/github', { method: 'DELETE' }).then(load, () => {})}>
              Remove
            </button>
          </div>
        ) : (
          <p className="text-sm text-slate-400">No token yet.</p>
        )}
        <div className="flex gap-2">
          <input className="input font-mono text-sm" type="password" autoComplete="off" placeholder={s?.hasToken ? 'Replace the token…' : 'github_pat_…'} value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn shrink-0" disabled={!token.trim()} onClick={() => save({ token })}>
            Save
          </button>
        </div>
      </div>
      {s?.hasToken && (
        <div className="card space-y-2">
          <h3 className="font-semibold">Commits are made by</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="input text-sm" placeholder={s.login ?? 'Name'} value={author.name} onChange={(e) => setAuthor({ ...author, name: e.target.value })} />
            <input className="input text-sm" placeholder={s.login ? `${s.login}@users.noreply.github.com` : 'E-mail'} value={author.email} onChange={(e) => setAuthor({ ...author, email: e.target.value })} />
          </div>
          <button className="btn" onClick={() => save({ authorName: author.name, authorEmail: author.email })}>
            Save
          </button>
          <p className="text-xs text-slate-500">Empty: your GitHub login and its noreply address.</p>
        </div>
      )}
    </div>
  );
}

const NEW_SKILL = `---
name: my-skill
description: When to use this skill, in one or two lines (the model reads this to decide).
---
# My skill

Instructions for the model…
`;

/** Settings → Skills: SKILL.md folders (like Claude skills) that AI model blocks can follow. */
export function SkillsPanel({ active, isAdmin }: { active: boolean; isAdmin: boolean }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [open, setOpen] = useState<{ skill: Skill; path: string; text: string; saved: string }>();
  const [gh, setGh] = useState({ repo: '', path: '', ref: '' });
  const load = () => api<Skill[]>('/api/skills', { quiet: true }).then(setSkills).catch(() => {});
  useEffect(() => {
    if (active) load();
  }, [active]);

  const report = (r: { skill: Skill; skipped: string[] }) => {
    toast(`Added ${r.skill.name}${r.skipped.length ? ` (left out: ${r.skipped.join(', ')})` : ''}`, 'ok');
    load();
  };
  const importZip = async (f: File) => {
    const res = await fetch('/api/skills/import', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: f });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error ?? `HTTP ${res.status}`);
    report(data);
  };
  const openFile = async (skill: Skill, path: string) => {
    try {
      const r = await api<{ text: string }>(`/api/skills/${skill.id}/file?path=${encodeURIComponent(path)}`);
      setOpen({ skill, path, text: r.text, saved: r.text });
    } catch {}
  };
  const saveFile = async () => {
    if (!open) return;
    try {
      const skill = await api<Skill>(`/api/skills/${open.skill.id}/file`, { method: 'PUT', body: { path: open.path, text: open.text } });
      setOpen({ ...open, skill, saved: open.text });
      toast('Saved', 'ok');
      load();
    } catch {}
  };

  return (
    <div className="space-y-4">
      <div className="card space-y-2">
        <h2 className="font-semibold">Skills</h2>
        <p className="text-sm text-slate-300">
          A skill is a folder with a <code>SKILL.md</code>: a name, a description of when to use it, then instructions. The same format as Claude skills, so yours work as they are. In an AI model
          block, pick skills under <b>Skills</b>, or let the model pick (Auto). Files in a skill are only read as text, never run.
        </p>
        <div className="flex flex-wrap gap-2">
          <label className="btn cursor-pointer">
            Upload a .zip
            <input type="file" accept=".zip" hidden onChange={(e) => e.target.files?.[0] && importZip(e.target.files[0])} />
          </label>
          <button className="btn-ghost" onClick={() => api('/api/skills', { body: { skillMd: NEW_SKILL } }).then(report, () => {})}>
            Write a new one
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <input className="input max-w-xs py-1 text-sm" placeholder="GitHub owner/repo" value={gh.repo} onChange={(e) => setGh({ ...gh, repo: e.target.value })} />
          <input className="input max-w-xs py-1 text-sm" placeholder="folder (optional)" value={gh.path} onChange={(e) => setGh({ ...gh, path: e.target.value })} />
          <input className="input w-32 py-1 text-sm" placeholder="branch" value={gh.ref} onChange={(e) => setGh({ ...gh, ref: e.target.value })} />
          <button className="btn-ghost" disabled={!gh.repo} onClick={() => api('/api/skills/import/github', { body: gh }).then(report, () => {})}>
            Import from GitHub
          </button>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
        <div className="space-y-2">
          {skills.length === 0 && <p className="text-sm text-slate-400">No skills yet.</p>}
          {skills.map((s) => (
            <div key={s.id} className="card space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.name}</span>
                {s.shared && <span className="rounded bg-indigo-500/20 px-1.5 text-xs text-indigo-300">shared</span>}
                {!s.mine && s.owner && <span className="text-xs text-slate-500">by {s.owner}</span>}
                <span className="ml-auto text-xs text-slate-500">{(s.sizeBytes / 1024).toFixed(1)} KB</span>
              </div>
              <p className="text-xs text-slate-400">{s.description}</p>
              <div className="flex flex-wrap gap-x-2 text-xs">
                {s.files.map((f) => (
                  <button key={f.path} className="font-mono text-sky-400 hover:underline" onClick={() => openFile(s, f.path)}>
                    {f.path}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {(s.mine || isAdmin) && (
                  <button
                    className="btn-ghost px-2 py-0.5 text-xs"
                    onClick={async () => {
                      const path = prompt('New file in this skill', 'reference.md');
                      if (path) await api(`/api/skills/${s.id}/file`, { method: 'PUT', body: { path, text: '' } }).then(load, () => {});
                    }}
                  >
                    Add file
                  </button>
                )}
                <a className="btn-ghost px-2 py-0.5 text-xs" href={`/api/skills/${s.id}/zip`}>
                  Export .zip
                </a>
                {isAdmin && (
                  <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => api(`/api/skills/${s.id}/shared`, { method: 'PUT', body: { shared: !s.shared } }).then(load, () => {})}>
                    {s.shared ? 'Stop sharing' : 'Share with everyone'}
                  </button>
                )}
                {(s.mine || isAdmin) && (
                  <button className="btn-ghost px-2 py-0.5 text-xs text-red-300" onClick={() => confirm(`Delete the skill ${s.name}?`) && api(`/api/skills/${s.id}`, { method: 'DELETE' }).then(() => (setOpen(undefined), load()), () => {})}>
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div>
          {open ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">
                  {open.skill.name}/{open.path}
                </span>
                {open.text !== open.saved && <span className="text-xs text-amber-300">not saved</span>}
                {(open.skill.mine || isAdmin) && open.path !== 'SKILL.md' && (
                  <button
                    className="btn-ghost ml-auto px-2 py-0.5 text-xs text-red-300"
                    onClick={() => api<Skill>(`/api/skills/${open.skill.id}/file?path=${encodeURIComponent(open.path)}`, { method: 'DELETE' }).then(() => (setOpen(undefined), load()), () => {})}
                  >
                    Delete file
                  </button>
                )}
                {(open.skill.mine || isAdmin) && (
                  <button className={`btn px-3 py-1 text-sm ${open.path === 'SKILL.md' ? 'ml-auto' : ''}`} disabled={open.text === open.saved} onClick={saveFile}>
                    Save
                  </button>
                )}
              </div>
              <textarea
                className="input min-h-[60vh] font-mono text-xs leading-5"
                spellCheck={false}
                readOnly={!open.skill.mine && !isAdmin}
                value={open.text}
                onChange={(e) => setOpen({ ...open, text: e.target.value })}
              />
            </div>
          ) : (
            <p className="text-sm text-slate-400">Pick a file of a skill to read or edit it.</p>
          )}
        </div>
      </div>
    </div>
  );
}
