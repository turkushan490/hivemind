import { useEffect, useState } from 'react';

/** Narrower than 768 px: the phone layout (bottom bar, bottom sheets, chat-style question box). */
const QUERY = '(max-width: 767px)';

export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return;
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}
