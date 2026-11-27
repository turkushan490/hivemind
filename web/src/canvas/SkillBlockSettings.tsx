import type { NodeConfig, Skill } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';

const Label = ({ children }: { children: React.ReactNode }) => <div className="text-xs font-semibold text-slate-300">{children}</div>;

/** The Skill block: read (pick the skill to load, or the one the request names) or save (as its own name, or "save as"). */
export function SkillBlockSettings(p: { config: NodeConfig; onChange: (patch: Partial<NodeConfig>) => void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    api<Skill[]>('/api/skills', { quiet: true }).then(setSkills).catch(() => {});
  }, []);
  const save = p.config.skillOp === 'save';
  const name = p.config.skillName ?? '';
  const known = skills.some((s) => s.name === name);
  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <Label>What it does</Label>
        <select className="input text-sm" value={save ? 'save' : 'read'} onChange={(e) => p.onChange({ skillOp: e.target.value === 'read' ? undefined : 'save', skillName: undefined })}>
          <option value="read">Read: load a skill (to change it)</option>
          <option value="save">Save: the text wired in becomes a skill</option>
        </select>
      </label>
      {!save ? (
        <label className="block space-y-1">
          <Label>Skill to load</Label>
          <select className="input text-sm" value={known ? name : name ? '__typed' : ''} onChange={(e) => p.onChange({ skillName: e.target.value === '' ? undefined : e.target.value === '__typed' ? name || '{{vars.skill}}' : e.target.value })}>
            <option value="">The one the request names</option>
            {skills.map((s) => (
              <option key={s.id} value={s.name}>
                {s.hidden ? '🔒 ' : ''}
                {s.name}
              </option>
            ))}
            <option value="__typed">Other (type a name or {'{{template}}'})…</option>
          </select>
          {name && !known && <input className="input text-sm" value={name} onChange={(e) => p.onChange({ skillName: e.target.value || undefined })} />}
        </label>
      ) : (
        <label className="block space-y-1">
          <Label>Save as (optional)</Label>
          <input className="input text-sm" placeholder="empty: the name in the SKILL.md (same name = overwrite)" value={name} onChange={(e) => p.onChange({ skillName: e.target.value || undefined })} />
          <span className="block text-xs text-slate-500">
            A new name keeps the old skill as it was and saves the changed one as a new skill. A name that already exists is overwritten. {'{{vars.name}}'} works too.
          </span>
        </label>
      )}
      <p className="text-xs text-slate-500">In a hidden workflow it also reads your locked skills, and a new skill it saves is locked. A normal workflow never changes a locked skill.</p>
    </div>
  );
}
