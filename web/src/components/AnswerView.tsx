import type { OutputFile } from '@hivemind/shared';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useState } from 'react';
import { toast } from '../notify';

export const fileUrl = (path: string, inline = true) => `/api/files/raw?${inline ? 'inline=1&' : ''}path=${encodeURIComponent(path)}`;

/** A website in the answer: a ```html block, or the whole answer when it is an HTML document. */
export function findHtml(text?: string): string | undefined {
  if (!text) return;
  const block = text.match(/```html?[^\n]*\n([\s\S]*?)```/i)?.[1];
  if (block) return block.trim();
  if (/^\s*(<!doctype html|<html)/i.test(text)) return text.trim();
}

/** Markdown → safe HTML; hm-file: links become pictures/downloads from the files folder. */
function render(text: string): string {
  const html = marked.parse(text, { async: false, breaks: true }) as string;
  const withFiles = html.replace(/(src|href)="hm-file:([^"]+)"/g, (_, attr, p) => `${attr}="${fileUrl(decodeURIComponent(p))}"`);
  return DOMPurify.sanitize(withFiles, { ADD_ATTR: ['target'] });
}

/**
 * Websites from models run in a sandboxed frame with an opaque origin: their scripts work,
 * but they can never reach HiveMind's cookies, pages or API.
 */
export function SitePreview({ html, height = 480 }: { html: string; height?: number }) {
  return <iframe title="Website preview" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={html} className="w-full rounded-md border border-[#30363d] bg-white" style={{ height }} />;
}

/** Opens the site in a new tab, still inside a sandboxed frame. */
export function openSiteInTab(html: string) {
  const w = window.open('', '_blank');
  if (!w) return toast('Your browser blocked the new tab', 'info');
  w.document.title = 'HiveMind preview';
  const frame = w.document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
  frame.srcdoc = html;
  frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff';
  w.document.body.style.margin = '0';
  w.document.body.appendChild(frame);
}

export function downloadText(name: string, text: string, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Files a run made: pictures as thumbnails, everything else as download chips; HTML files can be previewed. */
export function FileChips({ files, onPreviewHtml }: { files: OutputFile[]; onPreviewHtml?: (html: string) => void }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {files.map((f) =>
        f.kind === 'image' ? (
          <a key={f.path} href={fileUrl(f.path)} target="_blank" rel="noreferrer" title={f.path}>
            <img src={fileUrl(f.path)} alt="" className="hm-pop h-24 w-24 rounded-md border border-[#30363d] object-cover" />
          </a>
        ) : (
          <span key={f.path} className="flex items-center gap-1 rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1 text-xs">
            📄 {f.path.split('/').pop()}
            {f.kind === 'html' && onPreviewHtml && (
              <button
                className="ml-1 text-indigo-400 hover:underline"
                onClick={async () => onPreviewHtml(await (await fetch(fileUrl(f.path))).text())}
              >
                preview
              </button>
            )}
            <a className="ml-1 text-indigo-400 hover:underline" href={fileUrl(f.path, false)}>
              download
            </a>
          </span>
        ),
      )}
    </div>
  );
}

/** A final answer: formatted text, a live preview when it made a website, and the files it saved. */
export function AnswerView({ text, files = [], compact }: { text?: string; files?: OutputFile[]; compact?: boolean }) {
  const inlineHtml = useMemo(() => findHtml(text), [text]);
  const [fileHtml, setFileHtml] = useState<string>();
  const html = fileHtml ?? inlineHtml;
  const [tab, setTab] = useState<'answer' | 'preview' | 'code'>(html ? 'preview' : 'answer');
  useEffect(() => {
    if (html) setTab('preview');
  }, [!!html]);
  const rendered = useMemo(() => (text ? render(text) : ''), [text]);

  return (
    <div className="space-y-2">
      {html && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {(['preview', 'code', 'answer'] as const).map((t) => (
            <button key={t} className={`rounded-md px-2 py-1 ${tab === t ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-[#21262d]'}`} onClick={() => setTab(t)}>
              {t === 'preview' ? '🌐 Preview' : t === 'code' ? 'Code' : 'Answer'}
            </button>
          ))}
          <button className="btn-ghost ml-auto px-2 py-0.5 text-xs" onClick={() => openSiteInTab(html)}>
            Open in new tab
          </button>
          <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => downloadText('site.html', html, 'text/html')}>
            Download .html
          </button>
        </div>
      )}
      {html && tab === 'preview' && <SitePreview html={html} height={compact ? 360 : 520} />}
      {html && tab === 'code' && (
        <div className="relative">
          <button className="btn-ghost absolute top-1 right-1 px-2 py-0.5 text-xs" onClick={() => navigator.clipboard.writeText(html).then(() => toast('Copied', 'ok'))}>
            Copy
          </button>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-[#0d1117] p-3 text-xs text-slate-300">{html}</pre>
        </div>
      )}
      {(!html || tab === 'answer') && text && <div className="hm-md text-sm leading-relaxed text-slate-200" dangerouslySetInnerHTML={{ __html: rendered }} />}
      <FileChips files={files} onPreviewHtml={(h) => setFileHtml(h)} />
    </div>
  );
}
