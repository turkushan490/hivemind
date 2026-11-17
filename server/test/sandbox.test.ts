import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { node, runAndWait, testApp } from './helpers.js';

let app: FastifyInstance;
let sandbox: typeof import('../src/services/sandbox.js');
const linux = process.platform !== 'win32';

beforeAll(async () => {
  ({ app } = await testApp('sandbox'));
  sandbox = await import('../src/services/sandbox.js');
});
afterAll(() => app.close());

describe('Shell sandbox (H18)', () => {
  it('refuses wiping the disk, mounts, Docker, HiveMind data and ssh to the LAN', () => {
    expect(sandbox.refusedCommand('rm -rf /')).toMatch(/refused/);
    expect(sandbox.refusedCommand('sudo rm -rf --no-preserve-root /*')).toMatch(/refused/);
    expect(sandbox.refusedCommand('mount /dev/sda1 /mnt')).toMatch(/refused/);
    expect(sandbox.refusedCommand('cat /data/hivemind.db')).toMatch(/refused/);
    expect(sandbox.refusedCommand('docker ps')).toMatch(/refused/);
    expect(sandbox.refusedCommand('ssh root@192.168.0.6')).toMatch(/LAN/);
    expect(sandbox.refusedCommand('ssh root@192.168.0.6', { lan: true })).toBeUndefined();
    expect(sandbox.refusedCommand('rm -rf dist && go build -o dist/app.exe .')).toBeUndefined();
    expect(sandbox.refusedCommand('ls /data/sandbox')).toBeUndefined();
  });

  it('takes the commands out of a ```bash block a model wrote', async () => {
    const { commandsFrom } = await import('../src/nodes/agents.js');
    expect(commandsFrom('Run this:\n```bash\necho hi\nls\n```\nthen tell me')).toBe('echo hi\nls');
    expect(commandsFrom('echo plain')).toBe('echo plain');
  });

  it.skipIf(!linux)('runs bash, returns the exit code and output, and stops at the time limit', async () => {
    const ok = await sandbox.runShell({ key: 't1', shell: 'bash', commands: 'echo hello; echo oops >&2; exit 3', timeoutSec: 30 });
    expect(ok.exitCode).toBe(3);
    expect(ok.output).toContain('hello');
    expect(ok.output).toContain('oops');
    const slow = await sandbox.runShell({ key: 't2', shell: 'bash', commands: 'sleep 30', timeoutSec: 5 });
    expect(slow.exitCode).toBe('timeout');
    expect(slow.ms).toBeLessThan(15_000);
  }, 30_000);

  it.skipIf(!linux)('a Shell block in a run copies dist/ back into the project', async () => {
    const p = (await app.inject({ method: 'POST', url: '/api/projects', headers: { authorization: 'Bearer hm_u1' }, payload: { name: 'exe test' } })).json() as { id: string };
    const run = await runAndWait(app, {
      question: 'build',
      graph: {
        nodes: [node('q', 'input'), node('s', 'shell', { project: p.id, commands: 'mkdir -p dist && echo built > dist/app.txt && echo done' }), node('o', 'output')],
        edges: [
          { id: 'e1', source: 'q', target: 's' },
          { id: 'e2', source: 's', target: 'o' },
        ],
      },
    });
    expect(run.status).toBe('done');
    expect(run.final).toContain('exit code 0');
    expect(run.final).toContain('dist/');
    const { rootOf } = await import('../src/services/projects.js');
    const f = join(rootOf(p), 'dist', 'app.txt');
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf8').trim()).toBe('built');
  }, 60_000);
});
