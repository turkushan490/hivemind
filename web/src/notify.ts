import { useEffect, useState } from 'react';

export interface Toast {
  id: number;
  kind: 'error' | 'ok' | 'info';
  text: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<(t: Toast[]) => void>();

function set(next: Toast[]) {
  toasts = next;
  listeners.forEach((l) => l(toasts));
}

export function toast(text: string, kind: Toast['kind'] = 'error') {
  // Same message twice in a row: don't stack it.
  if (toasts.some((t) => t.text === text)) return;
  const id = nextId++;
  set([...toasts, { id, kind, text }]);
  setTimeout(() => dismiss(id), kind === 'error' ? 10_000 : 4_000);
}

export const dismiss = (id: number) => set(toasts.filter((t) => t.id !== id));

export function useToasts(): Toast[] {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return list;
}

/** Sends a browser-side crash to the server's Problems log. Never throws. */
export function reportProblem(message: string, detail?: string) {
  fetch('/api/problems/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: message.slice(0, 2000), detail: detail?.slice(0, 20000) }),
  }).catch(() => {});
}
