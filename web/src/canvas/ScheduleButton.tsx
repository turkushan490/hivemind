import { SCHEDULE_DAYS, type ScheduleDay, type WorkflowSchedule } from '@hivemind/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

const DAY_LABEL: Record<ScheduleDay, string> = { mon: 'Mo', tue: 'Tu', wed: 'We', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su' };

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

/** "Schedule": the saved workflow runs by itself at a time of day (the server's local time), on the days you pick. */
export function ScheduleButton({ canvasId }: { canvasId?: string }) {
  const [open, setOpen] = useState(false);
  const [sched, setSched] = useState<WorkflowSchedule | null>(null);
  const [time, setTime] = useState('03:00');
  const [days, setDays] = useState<ScheduleDay[]>([...SCHEDULE_DAYS]);
  const box = useRef<HTMLDivElement>(null);

  const load = () => {
    if (!canvasId) return setSched(null);
    api<WorkflowSchedule>(`/api/workflows/${canvasId}/schedule`, { quiet: true })
      .then((s) => {
        setSched(s);
        setTime(s.time);
        setDays(s.days);
      })
      .catch(() => setSched(null));
  };
  useEffect(load, [canvasId]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const save = async (enabled = true) => {
    if (!canvasId) return toast('Save the workflow first, then schedule it', 'info');
    if (!days.length) return toast('Pick at least one day', 'info');
    try {
      const s = await api<WorkflowSchedule>(`/api/workflows/${canvasId}/schedule`, { method: 'PUT', body: { time, days, enabled } });
      setSched(s);
      toast(enabled ? `Runs by itself at ${s.time} — next: ${when(s.nextRunAt)}` : 'Schedule paused', 'ok');
      setOpen(false);
    } catch {}
  };
  const remove = async () => {
    await api(`/api/workflows/${canvasId}/schedule`, { method: 'DELETE' }).catch(() => {});
    setSched(null);
    setOpen(false);
  };
  const toggle = (d: ScheduleDay) => setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : SCHEDULE_DAYS.filter((y) => y === d || x.includes(y))));

  return (
    <div ref={box} className="relative">
      <button
        className={`btn-ghost ${sched?.enabled ? 'border-emerald-700 text-emerald-300' : ''}`}
        title={sched?.enabled ? `Runs by itself at ${sched.time}; next ${when(sched.nextRunAt)}` : 'Run this workflow by itself every night (or on the days you pick)'}
        onClick={() => setOpen(!open)}
      >
        {sched?.enabled ? `⏰ ${sched.time}` : 'Schedule'}
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-80 space-y-2 rounded-lg border border-[#30363d] bg-[#161b22] p-3 text-xs shadow-xl">
          <div className="font-semibold text-slate-200">Run this workflow by itself</div>
          {!canvasId ? (
            <p className="text-amber-300">Save the workflow first.</p>
          ) : (
            <>
              <label className="flex items-center gap-2">
                <span className="w-12 text-slate-400">At</span>
                <input className="input w-28 py-1 text-xs" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                <span className="text-slate-500">server time</span>
              </label>
              <div className="flex items-center gap-1">
                <span className="w-12 text-slate-400">On</span>
                {SCHEDULE_DAYS.map((d) => (
                  <button
                    key={d}
                    className={`rounded px-1.5 py-0.5 ${days.includes(d) ? 'bg-indigo-500/30 text-indigo-100' : 'text-slate-500 hover:text-slate-300'}`}
                    onClick={() => toggle(d)}
                  >
                    {DAY_LABEL[d]}
                  </button>
                ))}
              </div>
              {sched && (
                <p className="text-slate-400">
                  Last run: {when(sched.lastRunAt)} · next: {sched.enabled ? when(sched.nextRunAt) : 'paused'}
                </p>
              )}
              <p className="text-[11px] text-slate-500">
                It runs the saved workflow as you, with the question “Scheduled run”. Train blocks in a scheduled run wait for the training window (Settings → Training).
              </p>
              <div className="flex gap-2">
                <button className="btn flex-1" onClick={() => save(true)}>
                  {sched ? 'Save' : 'Schedule it'}
                </button>
                {sched?.enabled && (
                  <button className="btn-ghost" onClick={() => save(false)}>
                    Pause
                  </button>
                )}
                {sched && (
                  <button className="btn-ghost text-red-400" onClick={remove}>
                    Remove
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
