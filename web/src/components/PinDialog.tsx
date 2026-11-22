import { useEffect, useState, type FormEvent } from 'react';
import { toast } from '../notify';
import { loadUnlock, setUnlock, setUnlockPin, useUnlock } from '../unlock';

/** Asks the PIN to unlock (or, the first time, sets one and unlocks). */
export function PinDialog({ hasPin, onClose }: { hasPin: boolean; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!hasPin && pin !== again) return setErr('The two PINs are not the same');
    setBusy(true);
    try {
      if (!hasPin) await setUnlockPin(pin);
      await setUnlock(true, pin);
      onClose();
    } catch (e2) {
      setErr((e2 as Error).message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="card w-80 space-y-3" onSubmit={submit}>
        <h3 className="font-semibold">{hasPin ? '🔒 Unlock' : '🔒 Set a PIN for unlock mode'}</h3>
        {!hasPin && <p className="text-xs text-slate-400">4 to 32 characters. You need it every time you unlock; change it in Settings → Unlock PIN.</p>}
        <input className="input w-full" type="password" autoFocus autoComplete="off" placeholder="PIN" value={pin} onChange={(e) => setPin(e.target.value)} />
        {!hasPin && <input className="input w-full" type="password" autoComplete="off" placeholder="PIN again" value={again} onChange={(e) => setAgain(e.target.value)} />}
        {err && <p className="text-sm text-red-300">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || pin.length < 4}>
            {busy ? '…' : 'Unlock'}
          </button>
        </div>
        <p className="text-xs text-slate-500">It locks again by itself after 12 hours, and when you log out.</p>
      </form>
    </div>
  );
}

/** Settings → Unlock PIN: set or change the PIN. */
export function UnlockPinPanel() {
  const unlock = useUnlock();
  const [old, setOld] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => void loadUnlock(), []);

  if (!unlock.allowed) return <div className="card max-w-2xl text-sm text-slate-400">Unlock mode is only for a login on the screen.</div>;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (pin !== again) return toast('The two new PINs are not the same');
    setBusy(true);
    try {
      await setUnlockPin(pin, unlock.hasPin ? old : undefined);
      toast(unlock.hasPin ? 'PIN changed' : 'PIN set', 'ok');
      setOld('');
      setPin('');
      setAgain('');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card max-w-2xl space-y-3" onSubmit={save}>
      <h3 className="font-semibold">Unlock PIN</h3>
      <p className="text-sm text-slate-400">
        The 🔒 next to Problems shows hidden workflows and the hidden memory (Memory → 🔓 Hidden memory). It asks this PIN, locks again by itself after 12 hours, and when you
        log out. API tokens (T3 Code, robots, apps) never see the hidden part.
      </p>
      <p className="text-sm">{unlock.hasPin ? 'A PIN is set.' : 'No PIN yet.'}</p>
      {unlock.hasPin && <input className="input w-64" type="password" autoComplete="off" placeholder="Current PIN" value={old} onChange={(e) => setOld(e.target.value)} />}
      <div className="flex flex-wrap gap-2">
        <input className="input w-64" type="password" autoComplete="new-password" placeholder="New PIN (4–32 characters)" value={pin} onChange={(e) => setPin(e.target.value)} />
        <input className="input w-64" type="password" autoComplete="new-password" placeholder="New PIN again" value={again} onChange={(e) => setAgain(e.target.value)} />
      </div>
      <button className="btn" disabled={busy || pin.length < 4 || (unlock.hasPin && !old)}>
        {unlock.hasPin ? 'Change PIN' : 'Set PIN'}
      </button>
    </form>
  );
}
