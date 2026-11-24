import { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

type LogMode = 'off' | 'on' | 'debug';
interface LogState {
  mode: LogMode;
  path: string;
  size: number;
  old: number;
}

const MODES: { id: LogMode; label: string; help: string }[] = [
  { id: 'off', label: 'Off', help: 'Nothing is written to the file. Problems still show on the Problems page.' },
  { id: 'on', label: 'On', help: 'Problems, crashes, warnings and start/stop. Small; fine to leave on.' },
  { id: 'debug', label: 'Debug', help: 'Also every request, debug lines and console output. Big; turn it on while chasing a problem, then back to On.' },
];

const mb = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Settings → Log file: off / on / debug, the end of the file, download and clear. */
export function LogFilePanel({ active }: { active: boolean }) {
  const [s, setS] = useState<LogState | null>(null);
  const [tail, setTail] = useState('');
  const refresh = () =>
    api<LogState & { text: string }>('/api/logs/tail?lines=200', { quiet: true })
      .then(({ text, ...st }) => {
        setS(st);
        setTail(text);
      })
      .catch(() => setS(null));
  useEffect(() => {
    if (!active) return;
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [active]);
  if (!s) return null;
  const setMode = async (mode: LogMode) => {
    const next = await api<LogState>('/api/settings/log', { method: 'PUT', body: { mode } }).catch(() => null);
    if (next) {
      setS(next);
      toast(`Log file: ${MODES.find((m) => m.id === mode)!.label}`, 'ok');
      refresh();
    }
  };
  return (
    <div className="card max-w-3xl space-y-3">
      <div>
        <h2 className="font-semibold">Log file</h2>
        <p className="text-sm text-slate-400">
          A plain-text log of what HiveMind does, to look at or send when something goes wrong. Keys, tokens and PINs are blanked out. It keeps two files (the
          current one and the one before), so it never grows without end.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {MODES.map((m) => (
          <button key={m.id} className={s.mode === m.id ? 'btn' : 'btn-ghost border border-[#30363d]'} onClick={() => s.mode !== m.id && setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="text-sm text-slate-300">{MODES.find((m) => m.id === s.mode)!.help}</p>
      <p className="text-xs text-slate-500">
        <code>{s.path}</code> · {mb(s.size)}
        {s.old > 0 && <> (+ {mb(s.old)} older)</>}
      </p>
      <div className="flex flex-wrap gap-2">
        <a className="btn-ghost border border-[#30363d]" href="/api/logs/download" download>
          Download
        </a>
        <button className="btn-ghost border border-[#30363d]" onClick={refresh}>
          Refresh
        </button>
        <button
          className="btn-ghost border border-[#30363d] text-red-300"
          onClick={async () => {
            if (!confirm('Empty the log file?')) return;
            await api('/api/logs', { method: 'DELETE' }).catch(() => {});
            refresh();
          }}
        >
          Clear
        </button>
      </div>
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded-md border border-[#30363d] bg-[#0d1117] p-2 text-xs text-slate-300">
        {tail || (s.mode === 'off' ? 'The log file is off.' : 'Empty so far.')}
      </pre>
    </div>
  );
}
