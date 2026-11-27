// The Skill block: read your skills (the one the request names, whole) or save the text wired in as a skill.
// A workflow can make and edit skills with it ("make a skill for X", "edit my skill Y: ..."). In a hidden workflow it
// also reads your locked skills, and a skill it makes is locked.
import { answers, fill, type NodeDefinition } from './index.js';

/** The SKILL.md in a model's answer: the text inside a ``` fence when there is one, from its --- front matter on. */
export function skillFromAnswer(text: string): string {
  let t = text.trim();
  const fence = /```(?:markdown|md|yaml)?\s*\n([\s\S]*?)\n```/i.exec(t);
  if (fence && /^---\s*$/m.test(fence[1])) t = fence[1].trim();
  const start = t.search(/^---\s*$/m);
  if (start > 0) t = t.slice(start);
  return t.trim();
}

/** Skills named in this text (whole name, or with spaces for its - and _), longest names first. */
export function namedSkills(text: string, names: string[]): string[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, ' ')} `;
  return names
    .filter((n) => {
      const words = n.toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, ' ').trim();
      return words && t.includes(` ${words} `);
    })
    .sort((a, b) => b.length - a.length);
}

export const SKILL_NODE: NodeDefinition = {
  usesModel: false,
  async execute(ctx) {
    const svc = ctx.services.skills;
    if (!svc) throw new Error('Skills are not available here');
    const input = answers(ctx.inputs).map((a) => a.text).join('\n\n').trim();

    if ((ctx.node.config.skillOp ?? 'read') === 'save') {
      if (!svc.save) throw new Error('Saving skills is not available here');
      const md = skillFromAnswer(input);
      if (!md) throw new Error('Nothing to save: wire in the block that writes the skill');
      const r = svc.save(md, ctx.node.config.skillName ? fill(ctx.node.config.skillName, ctx, input).trim() || undefined : undefined);
      ctx.progress(`${r.created ? 'Made' : 'Updated'} the skill "${r.name}"${r.locked ? ' (locked)' : ''}`);
      return `${r.created ? 'Made' : 'Updated'} the skill "${r.name}"${r.locked ? ' (locked: only shown while unlocked)' : ''}.\n\n${md}`;
    }

    // Read: the list of your skills, and whole the ones the request (or the text wired in) names.
    const all = svc.list();
    const spec = ctx.node.config.skillName ? fill(ctx.node.config.skillName, ctx, input) : `${ctx.question}\n${input}`;
    const hits = namedSkills(spec, all.map((s) => s.name)).slice(0, 3);
    const parts = [`Your skills (${all.length}):\n${all.map((s) => `- ${s.name}: ${s.description}`).join('\n') || '(none yet)'}`];
    for (const name of hits) {
      const raw = svc.raw?.(name);
      if (raw) parts.push(`The skill "${name}" as it is now (edit this one):\n${raw.map((f) => `### ${f.path}\n\`\`\`markdown\n${f.text}\n\`\`\``).join('\n\n')}`);
    }
    if (!hits.length) parts.push('No existing skill is named in the request: write a new one.');
    ctx.progress(hits.length ? `Read the skill${hits.length > 1 ? 's' : ''} ${hits.join(', ')}` : `${all.length} skills, none named in the request`);
    return parts.join('\n\n---\n\n');
  },
};
