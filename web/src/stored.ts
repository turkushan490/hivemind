import { useEffect, useState } from 'react';

/** useState that is also kept in localStorage, so choices survive tab switches and reloads. */
export function useStored<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`hm.${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`hm.${key}`, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue];
}
