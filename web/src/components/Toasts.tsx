import { dismiss, useToasts } from '../notify';

const STYLE = {
  error: 'border-red-700 bg-red-950/90 text-red-100',
  ok: 'border-emerald-700 bg-emerald-950/90 text-emerald-100',
  info: 'border-[#30363d] bg-[#161b22]/95 text-slate-200',
};

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${STYLE[t.kind]}`}>
          <span className="flex-1 break-words">{t.text}</span>
          <button aria-label="Close" className="opacity-60 hover:opacity-100" onClick={() => dismiss(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
