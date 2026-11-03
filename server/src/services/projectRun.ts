import type { FileChange } from '@hivemind/shared';
import type { ProjectServices } from '../nodes/projects.js';
import { buildProject } from './build.js';
import type { FileUser } from './files.js';
import { gitCommit, gitPull, gitPullRequest, gitPush } from './git.js';
import { deleteProjectPath, findProject, getProject, previewUrl, projectTree, readProjectText, recordChanges, writeProjectFile } from './projects.js';

/** The project blocks' services for one run, as the person who runs it (their projects, their GitHub token). */
export function projectServicesFor(user: FileUser, run: { id: string; source: string }): ProjectServices {
  const changes = new Map<string, FileChange>();
  const own = (id: string) => getProject(user, id);
  return {
    find(idOrName) {
      const r = findProject(user, idOrName);
      return { id: r.id, name: r.name, ...(r.github_repo && { repo: r.github_repo, branch: r.github_branch ?? 'main' }) };
    },
    tree: (id) => projectTree(own(id)),
    read: (id, path) => readProjectText(own(id), path),
    write: (id, path, content, mode) => writeProjectFile(own(id), path, content, { byBlock: true, mode }),
    remove: (id, path) => deleteProjectPath(own(id), path),
    record(id, list) {
      recordChanges(id, list, run.source, run.id);
      for (const c of list) if (c.status !== 'skipped') changes.set(`${id}:${c.path}`, c);
    },
    changes: () => [...changes.values()],
    previewUrl: (id, path = '') => previewUrl(own(id).id, path),
    async git(id, action, opts) {
      const p = own(id);
      if (action === 'pull') {
        const r = await gitPull(p, user.id, opts.signal);
        return { text: r.updated ? 'Pulled the newest commits from GitHub' : 'Already up to date with GitHub' };
      }
      if (action === 'pr') {
        const r = await gitPullRequest(p, user.id, { title: opts.message, body: opts.body ?? opts.message, branch: opts.branch, signal: opts.signal });
        return { text: `Pull request from ${r.branch}`, url: r.url, ...(r.sha && { sha: r.sha }) };
      }
      let text = '';
      let sha: string | undefined;
      if (action === 'commit' || action === 'commitPush') {
        const c = await gitCommit(p, user.id, opts.message, opts.signal);
        sha = c.sha;
        text = c.nothing ? 'Nothing new to commit' : `Committed ${c.sha!.slice(0, 7)}: ${opts.message.split('\n')[0].slice(0, 80)}`;
        if (action === 'commit') return { text, ...(sha && { sha }) };
      }
      const pushed = await gitPush(p, user.id, opts.signal);
      return { text: `${text ? `${text}. ` : ''}Pushed to ${pushed.branch}`, url: pushed.url, ...(sha && { sha }) };
    },
    build: (id, opts) => buildProject(own(id), opts),
  };
}
