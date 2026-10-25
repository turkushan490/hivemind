import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api(setup ? '/api/setup' : '/api/auth/login', { body: { username, password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-3">
        <div className="flex items-center gap-2">
          <img src="/icon.svg" className="h-8 w-8" alt="" />
          <h1 className="text-xl font-semibold">HiveMind</h1>
        </div>
        <p className="text-sm text-slate-400">{setup ? 'First start: create the admin account.' : 'Log in to continue.'}</p>
        <input className="input" placeholder="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          className="input"
          type="password"
          placeholder="Password"
          autoComplete={setup ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="btn w-full">{setup ? 'Create admin' : 'Log in'}</button>
      </form>
    </div>
  );
}
