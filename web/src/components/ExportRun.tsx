import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useRef, useState } from 'react';
import { reportProblem, toast } from '../notify';

/** Opens the run as a clean, light page and starts the browser's print dialog (Save as PDF). */
export async function printRun(runId: string) {
  // Opened right away (in the click), or the browser blocks it as a popup.
  const w = window.open('', '_blank');
  if (!w) return toast('The browser blocked the print window — allow popups for HiveMind', 'info');
  w.document.write('<p style="font-family:sans-serif;color:#555">Preparing…</p>');
  try {
    const res = await fetch(`/api/runs/${runId}/export.md`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    const md = await res.text();
    const body = DOMPurify.sanitize(marked.parse(md, { async: false, breaks: true }) as string);
    const title = md.match(/^# (.*)$/m)?.[1] ?? 'HiveMind run';
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title></title><style>
      body{font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;max-width:780px;margin:32px auto;padding:0 24px}
      h1{font-size:22px;margin:0 0 8px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}h3{font-size:15px;margin:20px 0 4px}
      pre{background:#f5f5f7;padding:10px;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:12px}code{font-size:12px}
      blockquote{border-left:3px solid #c33;margin:8px 0;padding:2px 10px;color:#922}img{max-width:100%;border-radius:6px}
      table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}em{color:#555}
      .foot{margin-top:32px;color:#888;font-size:11px}@media print{body{margin:0 auto}h2,h3{break-after:avoid}pre,img{break-inside:avoid}}
    </style></head><body>${body}<div class="foot">Exported from HiveMind</div></body></html>`);
    w.document.close();
    w.document.title = title;
    const imgs = [...w.document.images];
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => ((i.onload = r), (i.onerror = r))))));
    w.focus();
    w.print();
  } catch (err) {
    w.close();
    const msg = `Could not make the PDF: ${(err as Error).message}`;
    toast(msg);
    reportProblem(msg, (err as Error).stack);
  }
}

/** "Export ▾": the run as Markdown, JSON or PDF (print). */
export function ExportRun({ runId, className = '' }: { runId: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const item = 'block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-[#21262d]';
  return (
    <div ref={box} className={`relative ${className}`}>
      <button type="button" className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setOpen((o) => !o)} title="Save this run as a document">
        Export ▾
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-48 rounded-lg border border-[#30363d] bg-[#161b22] p-1 shadow-xl">
          <a className={item} href={`/api/runs/${runId}/export.md`} onClick={() => setOpen(false)}>
            Markdown (.md)
          </a>
          <a className={item} href={`/api/runs/${runId}/export.json`} onClick={() => setOpen(false)}>
            JSON (.json)
          </a>
          <button
            className={item}
            onClick={() => {
              setOpen(false);
              printRun(runId);
            }}
          >
            PDF (print view)
          </button>
          <a className={item} href={`/api/runs/${runId}/export.zip`} onClick={() => setOpen(false)}>
            ZIP with files
          </a>
        </div>
      )}
    </div>
  );
}
