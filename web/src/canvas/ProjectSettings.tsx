import type { NodeConfig, NodeType, Project, Skill } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { GIT_ACTIONS, projectNames } from './meta';

interface Props {
  nodeId: string;
  kind: NodeType;
  config: NodeConfig;
  onChange: (patch: Partial<NodeConfig>) => void;
}

const Label = ({ children }: { children: React.ReactNode }) => <div className="text-xs font-semibold text-slate-300">{children}</div>;

/** Your projects, for pickers (also fills the names blocks show on the canvas). */
export function useProjects(active = true) {
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    if (!active) return;
    api<Project[]>('/api/projects', { quiet: true })
      .then((ps) => {
        ps.forEach((x) => projectNames.set(x.id, x.name));
        setProjects(ps);
      })
      .catch(() => {});
  }, [active]);
  return projects;
}

/** Which project a block works on: one of yours, or vars.project sent with the run. */
export function ProjectPicker({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const projects = useProjects();
  const known = !value || value.startsWith('{{') || projects.some((p) => p.id === value);
  return (
    <label className="block space-y-1">
      <Label>Project</Label>
      <select className="input text-xs" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">From the run (vars.project)</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.owner ? ` (${p.owner})` : ''}
          </option>
        ))}
        {!known && <option value={value}>{value}</option>}
      </select>
      <span className="text-xs text-slate-500">Make projects on the Projects page. "From the run": the project's name or id sent as vars.project, so one workflow works for many sites.</span>
    </label>
  );
}

export function ProjectBlockSettings(p: Props) {
  const c = p.config;
  return (
    <div className="space-y-2">
      <ProjectPicker value={c.project} onChange={(project) => p.onChange({ project })} />
      {p.kind === 'readProject' && (
        <>
          <label className="flex items-start gap-2 text-xs text-slate-300">
            <input type="checkbox" className="mt-0.5" checked={!!c.onlyNamed} onChange={(e) => p.onChange({ onlyNamed: e.target.checked || undefined })} />
            <span>
              <span className="font-semibold">Only the files named in the input</span>
              <span className="block text-slate-500">For a plan wired in ({'{"files": [{"path": …}]}'}), or a For each item.</span>
            </span>
          </label>
          {!c.onlyNamed && (
            <label className="block space-y-1">
              <Label>Files to read</Label>
              <input className="input font-mono text-xs" placeholder="*.html, *.css, *.js, *.md, *.json" value={c.globs ?? ''} onChange={(e) => p.onChange({ globs: e.target.value || undefined })} />
              <span className="text-xs text-slate-500">Patterns, comma separated: *.html (any folder), css/* (one folder), src/** (all below). PROJECT.md is always read.</span>
            </label>
          )}
          <label className="block space-y-1">
            <Label>Budget (characters)</Label>
            <input
              className="input text-xs"
              type="number"
              min={1000}
              max={500000}
              placeholder="60000"
              value={c.budget ?? ''}
              onChange={(e) => p.onChange({ budget: e.target.value ? Math.max(1000, Math.min(500_000, Number(e.target.value))) : undefined })}
            />
            <span className="text-xs text-slate-500">Files that don't fit are listed by name. About 4 characters per token: keep it under the model's context.</span>
          </label>
        </>
      )}
      {p.kind === 'writeFiles' && (
        <>
          <label className="block space-y-1">
            <Label>Existing files</Label>
            <select className="input text-xs" value={c.writeMode === 'new' ? 'new' : 'overwrite'} onChange={(e) => p.onChange({ writeMode: e.target.value === 'new' ? 'new' : undefined })}>
              <option value="overwrite">Overwrite them</option>
              <option value="new">Leave them, only add new files</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={!!c.optionalWrite} onChange={(e) => p.onChange({ optionalWrite: e.target.checked || undefined })} />
            An answer without files is fine (a reviewer with nothing to fix)
          </label>
          <p className="text-xs text-slate-500">
            Tell the model before it to answer with each file in a code block like <code>```html path=pages/about.html</code>. Scripts like .sh, .bat and .exe are never written.
          </p>
        </>
      )}
      {p.kind === 'git' && (
        <>
          <label className="block space-y-1">
            <Label>Action</Label>
            <select className="input text-xs" value={c.gitAction ?? 'commitPush'} onChange={(e) => p.onChange({ gitAction: e.target.value as NodeConfig['gitAction'] })}>
              {Object.entries(GIT_ACTIONS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {c.gitAction !== 'pull' && c.gitAction !== 'push' && (
            <label className="block space-y-1">
              <Label>{c.gitAction === 'pr' ? 'Pull request title' : 'Commit message'}</Label>
              <input className="input text-xs" placeholder="{{question}}" value={c.message ?? ''} onChange={(e) => p.onChange({ message: e.target.value || undefined })} />
            </label>
          )}
          {c.gitAction === 'pr' && (
            <label className="block space-y-1">
              <Label>Branch for the pull request</Label>
              <input className="input text-xs" placeholder="hivemind/<date> (new each run)" value={c.branch ?? ''} onChange={(e) => p.onChange({ branch: e.target.value || undefined })} />
            </label>
          )}
          <p className="text-xs text-slate-500">Uses your GitHub token (Settings → GitHub). Connect the project on the Projects page; without that, this block passes.</p>
        </>
      )}
      {p.kind === 'build' && (
        <>
          <label className="block space-y-1">
            <Label>npm script</Label>
            <input className="input font-mono text-xs" placeholder="build" value={c.script ?? ''} onChange={(e) => p.onChange({ script: e.target.value || undefined })} />
          </label>
          <label className="block space-y-1">
            <Label>Output folder</Label>
            <input className="input font-mono text-xs" placeholder="dist (else build or out)" value={c.outDir ?? ''} onChange={(e) => p.onChange({ outDir: e.target.value || undefined })} />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={!!c.buildFailOk} onChange={(e) => p.onChange({ buildFailOk: e.target.checked || undefined })} />
            A failed build passes its error on (to look it up and fix it)
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={!!c.buildOptional} onChange={(e) => p.onChange({ buildOptional: e.target.checked || undefined })} />
            No package.json is fine (nothing to build)
          </label>
          <p className="text-xs text-slate-500">Runs inside HiveMind on a copy of the project, with no access to HiveMind's keys, for at most 10 minutes.</p>
        </>
      )}
    </div>
  );
}

export function PauseSettings(p: Props) {
  const c = p.config;
  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <Label>Title</Label>
        <input className="input text-xs" placeholder="Check and continue" value={c.title ?? ''} onChange={(e) => p.onChange({ title: e.target.value || undefined })} />
      </label>
      <label className="block space-y-1">
        <Label>Message</Label>
        <textarea className="input min-h-16 text-xs" placeholder="What should the person check?" value={c.prompt ?? ''} onChange={(e) => p.onChange({ prompt: e.target.value || undefined })} />
      </label>
      <ProjectPicker value={c.project} onChange={(project) => p.onChange({ project })} />
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <Label>Wait at most (minutes)</Label>
          <input
            className="input text-xs"
            type="number"
            min={1}
            placeholder="forever"
            value={c.timeoutMinutes ?? ''}
            onChange={(e) => p.onChange({ timeoutMinutes: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
          />
        </label>
        <label className="block space-y-1">
          <Label>Then</Label>
          <select className="input text-xs" disabled={!c.timeoutMinutes} value={c.onTimeout ?? 'continue'} onChange={(e) => p.onChange({ onTimeout: e.target.value as NodeConfig['onTimeout'] })}>
            <option value="continue">Continue</option>
            <option value="reject">Reject</option>
            <option value="stop">Stop the run</option>
          </select>
        </label>
      </div>
      <p className="text-xs text-slate-500">
        Wire a block named <b>rejected</b> after it for what happens on Reject (e.g. a model that fixes things). The run shows the Pause on the canvas, in Use and under Activity → Waiting for you. A
        waiting run holds no GPU.
      </p>
    </div>
  );
}

export function ForeachSettings(p: Props) {
  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <Label>At most this many items</Label>
        <input
          className="input text-xs"
          type="number"
          min={1}
          max={500}
          placeholder="50"
          value={p.config.maxItems ?? ''}
          onChange={(e) => p.onChange({ maxItems: e.target.value ? Math.max(1, Math.min(500, Number(e.target.value))) : undefined })}
        />
      </label>
      <p className="text-xs text-slate-500">
        The blocks between this and a <b>Collect</b> block run once per item (a JSON list like {'{"files": [...]}'}, or one item per line). Blocks inside may also use blocks from before the For each.
      </p>
    </div>
  );
}

/** Skills (Settings → Skills) for AI model blocks: none, fixed ones, or the model's own pick. */
export function SkillsOption(p: Props) {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    api<Skill[]>('/api/skills', { quiet: true }).then(setSkills).catch(() => {});
  }, [p.nodeId]);
  const c = p.config;
  const mode = c.skillMode ?? (c.skills?.length ? 'fixed' : 'off');
  const chosen = new Set(c.skills ?? []);
  return (
    <div className="space-y-2 rounded-lg border border-[#30363d] p-2.5">
      <label className="block space-y-1">
        <span className="text-xs font-semibold text-slate-300">Skills</span>
        <select className="input text-xs" value={mode} onChange={(e) => p.onChange({ skillMode: e.target.value === 'off' ? undefined : (e.target.value as NodeConfig['skillMode']) })}>
          <option value="off">None</option>
          <option value="fixed">These skills</option>
          <option value="auto">Auto: the model picks (one short extra call)</option>
        </select>
      </label>
      {mode === 'fixed' && (
        <div className="max-h-40 space-y-1 overflow-auto">
          {skills.length === 0 && <p className="text-xs text-slate-500">No skills yet: add them in Settings → Skills.</p>}
          {skills.map((s) => (
            <label key={s.id} className="flex items-start gap-2 text-xs text-slate-300" title={s.description}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={chosen.has(s.name)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(s.name);
                  else next.delete(s.name);
                  p.onChange({ skills: next.size ? [...next] : undefined, skillMode: 'fixed' });
                }}
              />
              <span>
                {s.name}
                {s.shared && !s.mine && <span className="ml-1 text-slate-500">(shared)</span>}
                <span className="block text-slate-500">{s.description.slice(0, 90)}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      <span className="block text-xs text-slate-500">A skill's instructions go into the system prompt (they count towards the context). The run shows which skills were loaded.</span>
    </div>
  );
}
